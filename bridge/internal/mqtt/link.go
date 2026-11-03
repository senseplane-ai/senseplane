// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package mqtt is the bridge's MQTT link (ADR 0071), off unless a broker is
// configured. In: it learns sensors from Home Assistant MQTT discovery
// messages (and plain topics a person configures), lists them to choose from
// like Home Assistant's entities, and sends the readings of the chosen ones.
// Out: it publishes what the API lets this box publish (cameras online,
// people, vehicles and animals seen, watch firings) as Home Assistant
// discovery entities, so they show up in Home Assistant by themselves. The
// box connects out to the broker; it opens no port.
//
// The client is github.com/at-wat/mqtt-go (Apache-2.0), MQTT 3.1.1.
package mqtt

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	mq "github.com/at-wat/mqtt-go"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// Options configure the link.
type Options struct {
	// URL is the broker: mqtt://host:1883, mqtts://host:8883, ws:// or wss://.
	URL                string
	Username, Password string
	// ClientID defaults to senseplane-bridge-<random>.
	ClientID string
	// DiscoveryPrefix is Home Assistant's discovery prefix (default homeassistant).
	DiscoveryPrefix string
	// Prefix is where the box publishes its own states (default senseplane).
	Prefix string
	// Topics are plain topics to read, for devices without discovery.
	Topics []Topic
	// NoDiscovery leaves out the sensors discovery announces (a Home Assistant that lists them already).
	NoDiscovery bool
	// Hold is how long a detection's binary sensor stays on (default 60 s).
	Hold time.Duration
	// MinBackoff and MaxBackoff bound reconnecting (default 1 s to 1 min).
	MinBackoff, MaxBackoff time.Duration
	// KeepAlive is the MQTT keep-alive (default 30 s).
	KeepAlive time.Duration
	// CallTimeout bounds one publish or subscribe (default 5 s); a call that runs out drops the
	// connection, so a broker that stopped answering doesn't hold the link.
	CallTimeout time.Duration
	// MaxPayload is the largest message read (default 64 KiB); MaxEntities the most discovered entities kept (default 2,000).
	MaxPayload, MaxEntities int
	Log                     *slog.Logger
	// AwaitOutputs, when set, is how long the first connection waits for the API's first outputs answer, so
	// the box connects once, with the will it keeps (the bridge sets it; a link without outputs doesn't wait).
	// Connecting again for the will right after connecting races some brokers' cleanup of the first
	// connection, which can drop the new one's subscriptions (they go by client id).
	AwaitOutputs time.Duration
}

// CheckURL tells whether a broker URL can be used, without repeating it (it may hold a password).
func CheckURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errors.New("the MQTT broker URL can't be read; it looks like mqtt://host:1883")
	}
	switch u.Scheme {
	case "mqtt", "tcp", "mqtts", "ssl", "tls", "ws", "wss":
		return nil
	}
	return errors.New("the MQTT broker URL must start with mqtt://, mqtts://, ws:// or wss://")
}

// Sink is what the link tells the bridge (bridge.SensorSink).
type Sink interface {
	Connected(up bool)
	Entities(list []api.Entity)
	Reading(r api.Reading)
}

// Link is a connection to one broker; Run it, and give it outputs with Outputs.
type Link struct {
	o    Options
	msgs chan *mq.Message
	outs chan api.Outputs
	up   chan *mq.BaseClient

	mu  sync.Mutex
	cli *mq.BaseClient
	// announced is whether the box said it is online (it publishes); then it says goodbye too.
	announced atomic.Bool
	// will is the status topic to set as the will on the next connection ("" while the box doesn't publish);
	// connWill is the one the current connection has.
	will, connWill string
	// willKnown closes once the outputs said whether the box publishes (the will to connect with).
	willKnown chan struct{}
	willOnce  sync.Once
	// rewill is set when the link drops its connection to connect again with another will.
	rewill atomic.Bool

	// bad is set when the broker URL can't be used (the link then does nothing).
	bad error

	// Owned by the worker (run).
	entities map[string]*entity   // by discovery config topic (or plain topic)
	byState  map[string][]*entity // by state topic
	subbed   map[string]bool
	out      outputs
}

// New returns a link; nil options fields take the defaults.
func New(o Options) *Link {
	if o.DiscoveryPrefix == "" {
		o.DiscoveryPrefix = "homeassistant"
	}
	if o.Prefix == "" {
		o.Prefix = "senseplane"
	}
	if o.ClientID == "" {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		o.ClientID = "senseplane-bridge-" + hex.EncodeToString(b)
	}
	if o.Hold == 0 {
		o.Hold = time.Minute
	}
	if o.MinBackoff == 0 {
		o.MinBackoff = time.Second
	}
	if o.MaxBackoff == 0 {
		o.MaxBackoff = time.Minute
	}
	if o.KeepAlive == 0 {
		o.KeepAlive = 30 * time.Second
	}
	if o.CallTimeout == 0 {
		o.CallTimeout = 5 * time.Second
	}
	if o.MaxPayload == 0 {
		o.MaxPayload = 64 << 10
	}
	if o.MaxEntities == 0 {
		o.MaxEntities = 2000
	}
	// Credentials travel apart from the URL, which is then safe to dial and to show in errors.
	bad := CheckURL(o.URL)
	if bad == nil {
		u, _ := url.Parse(o.URL)
		if u.User != nil {
			if o.Username == "" {
				o.Username = u.User.Username()
				o.Password, _ = u.User.Password()
			}
			u.User = nil
			o.URL = u.String()
		}
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	l := &Link{o: o, msgs: make(chan *mq.Message, 4096), outs: make(chan api.Outputs, 8), up: make(chan *mq.BaseClient, 1), willKnown: make(chan struct{}),
		entities: map[string]*entity{}, byState: map[string][]*entity{}, subbed: map[string]bool{}, bad: bad}
	l.out = newOutputs(l)
	for i := range o.Topics {
		e := o.Topics[i].entity()
		l.entities["plain:"+e.stateTopic] = e
		l.byState[e.stateTopic] = append(l.byState[e.stateTopic], e)
	}
	return l
}

// Redact hides a broker URL's password, for logs; a URL that can't be read isn't shown at all.
func Redact(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<unparseable URL>"
	}
	if u.User == nil {
		return raw
	}
	if _, ok := u.User.Password(); ok {
		u.User = url.UserPassword(u.User.Username(), "xxxxx")
	}
	return u.String()
}

// Outputs takes what the API lets this box publish (ADR 0071); the newest wins.
func (l *Link) Outputs(o api.Outputs) {
	select {
	case l.outs <- o:
	default:
		// Full (the worker is busy): the oldest answer's state gives way to the newest, but its events
		// travel on in it, so a detection or a watch firing is never lost to a slow moment.
		select {
		case old := <-l.outs:
			if len(old.Events) > 0 {
				events := append(append([]api.OutputEvent(nil), old.Events...), o.Events...)
				o.Events = events[max(0, len(events)-maxCarriedEvents):]
			}
		default:
		}
		l.outs <- o // one caller (the outputs poll): there is room now
	}
}

// rewillPause is how long the link waits before connecting again for a new will.
const rewillPause = 300 * time.Millisecond

// maxCarriedEvents bounds the events carried from dropped answers into the newest one.
const maxCarriedEvents = 500

func (l *Link) client() *mq.BaseClient {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cli
}

// Run connects, reconnects with backoff and handles messages until ctx ends.
func (l *Link) Run(ctx context.Context, sink Sink) {
	if l.bad != nil {
		l.o.Log.Error("MQTT is off", "err", l.bad)
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		l.work(ctx, sink)
	}()
	l.connectLoop(ctx, sink)
	<-done
}

func (l *Link) connectLoop(ctx context.Context, sink Sink) {
	wait := l.o.MinBackoff
	if l.o.AwaitOutputs > 0 {
		select {
		case <-l.willKnown:
		case <-time.After(l.o.AwaitOutputs):
		case <-ctx.Done():
			return
		}
	}
	for ctx.Err() == nil {
		cli, will, err := l.connect(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			l.o.Log.Warn("MQTT broker not reachable; retrying", "broker", Redact(l.o.URL), "err", err, "in", wait.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			wait = min(wait*2, l.o.MaxBackoff)
			continue
		}
		wait = l.o.MinBackoff
		l.o.Log.Info("connected to the MQTT broker", "broker", Redact(l.o.URL))
		l.mu.Lock()
		l.cli = cli
		l.connWill = will
		l.mu.Unlock()
		// The worker subscribes and publishes on the newest connection (an older one not yet taken is dropped).
		select {
		case <-l.up:
		default:
		}
		l.up <- cli
		sink.Connected(true)
		kctx, cancel := context.WithCancel(ctx)
		go func() {
			if err := mq.KeepAlive(kctx, cli, l.o.KeepAlive, l.o.KeepAlive); err != nil && kctx.Err() == nil {
				cli.SetErrorOnce(err)
				_ = cli.Close()
			}
		}()
		select {
		case <-cli.Done():
			cancel()
			if l.rewill.Swap(false) {
				// Dropped on purpose for the will: give the broker a moment to finish with the old connection,
				// whose cleanup goes by client id, before the new one subscribes.
				select {
				case <-ctx.Done():
				case <-time.After(rewillPause):
				}
			} else {
				l.o.Log.Warn("lost the MQTT broker; reconnecting", "err", cli.Err())
			}
		case <-ctx.Done():
			cancel()
			// A clean goodbye: the box's entities show unavailable (the will isn't sent on a disconnect).
			bye, stop := context.WithTimeout(context.Background(), 3*time.Second)
			l.mu.Lock()
			will := l.connWill
			l.mu.Unlock()
			if l.announced.Load() && will != "" {
				_ = cli.Publish(bye, &mq.Message{Topic: will, Payload: []byte("offline"), Retain: true, QoS: mq.QoS1})
			}
			_ = cli.Disconnect(bye)
			stop()
		}
		l.mu.Lock()
		l.cli = nil
		l.mu.Unlock()
		sink.Connected(false)
	}
}

func (l *Link) connect(ctx context.Context) (*mq.BaseClient, string, error) {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cli, err := mq.DialContext(dctx, l.o.URL)
	if err != nil {
		return nil, "", err
	}
	// Messages are handed to the worker: the client reads the next packet only after this returns.
	cli.Handle(mq.HandlerFunc(func(m *mq.Message) {
		if len(m.Payload) > l.o.MaxPayload {
			l.o.Log.Debug("MQTT message too large; ignored", "topic", m.Topic, "bytes", len(m.Payload))
			return
		}
		select {
		case l.msgs <- m:
		default:
			l.o.Log.Warn("MQTT messages arrive faster than they are read; one dropped", "topic", m.Topic)
		}
	}))
	opts := []mq.ConnectOption{mq.WithKeepAlive(uint16(l.o.KeepAlive / time.Second)), mq.WithCleanSession(true)}
	// The will marks the box's entities unavailable if it drops off; only once it publishes.
	l.mu.Lock()
	will := l.will
	l.mu.Unlock()
	if will != "" {
		opts = append(opts, mq.WithWill(&mq.Message{Topic: will, Payload: []byte("offline"), Retain: true, QoS: mq.QoS1}))
	}
	user, pass := l.o.Username, l.o.Password
	if u, err := url.Parse(l.o.URL); err == nil && u.User != nil && user == "" {
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	if user != "" {
		opts = append(opts, mq.WithUserNamePassword(user, pass))
	}
	if _, err := cli.Connect(dctx, l.o.ClientID, opts...); err != nil {
		_ = cli.Close()
		return nil, "", err
	}
	return cli, will, nil
}

// setWill sets the will for the box's status topic (when it publishes) and, when the current connection
// was made with another, drops it to connect again with this one; true when it does.
func (l *Link) setWill(on bool, status string) bool {
	want := ""
	if on {
		want = status
	}
	l.mu.Lock()
	l.will = want
	cli := l.cli
	differs := cli != nil && l.connWill != want
	l.mu.Unlock()
	l.willOnce.Do(func() { close(l.willKnown) })
	if differs {
		l.rewill.Store(true)
		l.o.Log.Info("connecting to the MQTT broker again, to set the box's status", "status", want)
		// A clean goodbye, so the broker doesn't send the old will.
		bye, stop := context.WithTimeout(context.Background(), l.o.CallTimeout)
		if cli.Disconnect(bye) != nil {
			_ = cli.Close()
		}
		stop()
	}
	return differs
}

// work owns the entities and the outputs: messages, outputs and connections arrive here, one at a time.
func (l *Link) work(ctx context.Context, sink Sink) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	dirty := false
	flush := func() {
		if !dirty {
			return
		}
		dirty = false
		list := make([]api.Entity, 0, len(l.entities))
		for _, e := range l.entities {
			list = append(list, e.listed())
		}
		sort.Slice(list, func(i, j int) bool { return list[i].EntityID < list[j].EntityID })
		sink.Entities(list)
	}
	if len(l.entities) > 0 {
		dirty = true
		flush()
	}
	for {
		select {
		case <-ctx.Done():
			return
		case cli := <-l.up:
			l.subscribed(ctx, cli)
			l.out.connected(ctx)
		case o := <-l.outs:
			l.out.take(ctx, o)
		case now := <-tick.C:
			l.out.expire(ctx, now)
			flush()
		case m := <-l.msgs:
			if l.handle(ctx, sink, m) {
				dirty = true
			}
			if len(l.msgs) == 0 {
				flush()
			}
		}
	}
}

// subscribed subscribes a new connection to discovery, Home Assistant's status and every state topic known.
func (l *Link) subscribed(ctx context.Context, cli *mq.BaseClient) {
	dp := l.o.DiscoveryPrefix
	subs := []mq.Subscription{{Topic: dp + "/+/+/config", QoS: mq.QoS0}, {Topic: dp + "/+/+/+/config", QoS: mq.QoS0}, {Topic: dp + "/status", QoS: mq.QoS0}}
	l.subbed = map[string]bool{}
	for t := range l.byState {
		subs = append(subs, mq.Subscription{Topic: t, QoS: mq.QoS0})
		l.subbed[t] = true
	}
	sctx, cancel := context.WithTimeout(ctx, l.o.CallTimeout)
	defer cancel()
	// Brokers take a limited number of filters at once.
	for i := 0; i < len(subs); i += 50 {
		if _, err := cli.Subscribe(sctx, subs[i:min(i+50, len(subs))]...); err != nil {
			l.o.Log.Warn("MQTT subscribe failed", "err", err)
			_ = cli.Close()
			return
		}
	}
}

func (l *Link) subscribe(ctx context.Context, topic string) {
	if l.subbed[topic] {
		return
	}
	cli := l.client()
	if cli == nil {
		return // subscribed on the next connection
	}
	sctx, cancel := context.WithTimeout(ctx, l.o.CallTimeout)
	defer cancel()
	if _, err := cli.Subscribe(sctx, mq.Subscription{Topic: topic, QoS: mq.QoS0}); err != nil {
		l.o.Log.Warn("MQTT subscribe failed", "topic", topic, "err", err)
		l.timedOut(ctx, cli, err)
		return
	}
	l.subbed[topic] = true
}

// unsubscribe stops reading a state topic no entity uses any more.
func (l *Link) unsubscribe(ctx context.Context, topic string) {
	if !l.subbed[topic] {
		return
	}
	delete(l.subbed, topic)
	cli := l.client()
	if cli == nil {
		return
	}
	uctx, cancel := context.WithTimeout(ctx, l.o.CallTimeout)
	defer cancel()
	if err := cli.Unsubscribe(uctx, topic); err != nil {
		l.timedOut(ctx, cli, err)
	}
}

// timedOut drops a connection whose call ran out of time: a half-open one would hold every later call too.
func (l *Link) timedOut(ctx context.Context, cli *mq.BaseClient, err error) {
	if ctx.Err() == nil && errors.Is(err, context.DeadlineExceeded) {
		l.o.Log.Warn("the MQTT broker stopped answering; connecting again")
		_ = cli.Close()
	}
}

// handle takes one message; true when the entity list changed.
func (l *Link) handle(ctx context.Context, sink Sink, m *mq.Message) bool {
	dp := l.o.DiscoveryPrefix
	switch {
	case m.Topic == dp+"/status":
		// Home Assistant restarted: it forgets non-retained discovery, so it is sent again.
		if strings.EqualFold(strings.TrimSpace(string(m.Payload)), "online") {
			l.out.connected(ctx)
		}
		return false
	case strings.HasPrefix(m.Topic, dp+"/") && strings.HasSuffix(m.Topic, "/config"):
		if l.out.own(ctx, m.Topic, len(m.Payload) > 0) || l.o.NoDiscovery {
			return false
		}
		return l.discovered(ctx, m.Topic, m.Payload)
	}
	for _, e := range l.byState[m.Topic] {
		if r, ok := e.reading(m.Payload, time.Now(), m.Retain); ok {
			sink.Reading(r)
		}
	}
	return false
}

// discovered adds, replaces or (an empty payload) removes a discovered entity.
func (l *Link) discovered(ctx context.Context, topic string, payload []byte) bool {
	old := l.entities[topic]
	if old != nil {
		l.drop(old)
		delete(l.entities, topic)
	}
	if len(payload) == 0 {
		if old != nil {
			l.unused(ctx, old.stateTopic)
		}
		return old != nil
	}
	e, why := parseDiscovery(topic, payload, l.o.DiscoveryPrefix)
	if e == nil {
		l.o.Log.Debug("MQTT discovery ignored", "topic", topic, "why", why)
		return old != nil
	}
	if old == nil && len(l.entities) >= l.o.MaxEntities {
		l.o.Log.Warn("too many MQTT entities; one more ignored", "max", l.o.MaxEntities, "topic", topic)
		return false
	}
	l.entities[topic] = e
	l.byState[e.stateTopic] = append(l.byState[e.stateTopic], e)
	l.subscribe(ctx, e.stateTopic)
	if old != nil {
		l.unused(ctx, old.stateTopic)
	}
	return true
}

// unused unsubscribes a state topic once no entity reads it.
func (l *Link) unused(ctx context.Context, topic string) {
	if len(l.byState[topic]) == 0 {
		l.unsubscribe(ctx, topic)
	}
}

func (l *Link) drop(e *entity) {
	list := l.byState[e.stateTopic]
	for i, x := range list {
		if x == e {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(l.byState, e.stateTopic)
	} else {
		l.byState[e.stateTopic] = list
	}
}

// publish sends one message on the current connection; false when there is none or it failed.
func (l *Link) publish(ctx context.Context, topic string, payload []byte, retain bool) bool {
	cli := l.client()
	if cli == nil {
		return false
	}
	pctx, cancel := context.WithTimeout(ctx, l.o.CallTimeout)
	defer cancel()
	if err := cli.Publish(pctx, &mq.Message{Topic: topic, Payload: payload, Retain: retain, QoS: mq.QoS1}); err != nil {
		if !errors.Is(err, context.Canceled) {
			l.o.Log.Warn("MQTT publish failed", "topic", topic, "err", err)
		}
		l.timedOut(ctx, cli, err)
		return false
	}
	return true
}
