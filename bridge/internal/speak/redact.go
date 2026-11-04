// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"net/url"
	"regexp"
	"strings"
)

// A URL-looking word: scheme, colon, then anything up to a space or a quote.
var urlish = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*:[^\s"'<>]+`)

// Redact removes what may be a secret from every URL in s: the userinfo, every query and fragment
// value (cloud sources carry tokens there), and an exec: command's arguments. For logs and errors.
func Redact(s string) string {
	if i := strings.Index(strings.ToLower(s), "exec:"); i >= 0 {
		// A command line has no URL shape to keep: only the program's name is shown.
		return Redact(s[:i]) + RedactURL(s[i:])
	}
	return urlish.ReplaceAllStringFunc(s, func(w string) string {
		if !strings.Contains(w, "@") && !strings.ContainsAny(w, "?#") {
			return w
		}
		return RedactURL(w)
	})
}

// RedactURL is one talk-back or camera URL without its secrets, e.g. tapo://***@192.168.1.20.
func RedactURL(raw string) string {
	if IsExec(raw) {
		prog, _, _ := strings.Cut(strings.TrimSpace(raw[5:]), " ")
		prog, _, _ = strings.Cut(prog, "#")
		return "exec:" + prog + " ***"
	}
	u, err := url.Parse(raw)
	if err != nil {
		// Unparsable: keep the scheme only.
		if s := Scheme(raw); s != "" {
			return s + ":***"
		}
		return "***"
	}
	hadUser := u.User != nil
	u.User = nil
	if u.RawQuery != "" {
		q := u.Query()
		for k := range q {
			q[k] = []string{"***"}
		}
		u.RawQuery = strings.ReplaceAll(q.Encode(), "%2A", "*")
	}
	if u.Fragment != "" {
		u.Fragment = "***"
	}
	if u.Opaque != "" {
		u.Opaque = "***"
	}
	s := u.String()
	if hadUser {
		s = strings.Replace(s, "://", "://***@", 1)
	}
	return s
}
