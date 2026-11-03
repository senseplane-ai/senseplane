// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The workflow canvas (ADR 0072), drawn with React Flow (@xyflow/react, MIT):
// the trigger and the steps as nodes, the edges between them. Drag a step to
// move it, drag from a step's right edge (or its yes / no handle) to another
// step to join them, select an edge or step and press Backspace to remove it.
// A connection that would make a loop is refused as you draw. Read-only, it
// shows a run: each step coloured by how it went.
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge as FlowEdge, type Node, type NodeChange, type NodeProps,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import { BRANCHING, type Definition, connect, kindLabel, layout, removeStep, statusWord, stepSummary, triggerSummary } from "./model";
import "./workflows.css";

type StepData = { title: string; kind: string; summary: string; status?: string; branching: boolean; trigger: boolean };
type FlowNode = Node<StepData>;

function StepNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div className={`wf-node${data.trigger ? " wf-node-trigger" : ""}${selected ? " wf-node-selected" : ""}${data.status ? ` wf-status-${data.status}` : ""}`}
      data-testid={`node-${data.title}`}>
      {!data.trigger && <Handle type="target" position={Position.Left} />}
      <span className="wf-node-kind">{data.trigger ? "Trigger" : kindLabel(data.kind)}{data.status ? ` · ${statusWord[data.status] ?? data.status}` : ""}</span>
      <span className="wf-node-title">{data.title}</span>
      <span className="wf-node-sum">{data.summary}</span>
      {data.branching ? (
        <>
          <Handle type="source" position={Position.Right} id="yes" style={{ top: "35%" }} />
          <Handle type="source" position={Position.Right} id="no" style={{ top: "75%" }} />
          <span className="wf-branch wf-branch-yes">yes</span>
          <span className="wf-branch wf-branch-no">no</span>
        </>
      ) : <Handle type="source" position={Position.Right} />}
    </div>
  );
}
const nodeTypes = { step: StepNode };

export interface CanvasProps {
  def: Definition;
  onChange?: (def: Definition) => void;
  /** Says why a connection was refused (a loop, a branch from a step that doesn't branch). */
  onRefuse?: (why: string) => void;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** A run's step statuses, for the read-only view. */
  statuses?: Record<string, string>;
  name?: (id: string) => string;
  targetName?: (type: string, id: string) => string;
  label: string;
}

export function WorkflowCanvas({ def, onChange, onRefuse, selected, onSelect, statuses, name = (id) => id, targetName, label }: CanvasProps) {
  const readOnly = !onChange;
  const places = useMemo(() => layout(def), [def]);
  const build = (): FlowNode[] => [
    {
      id: "trigger", type: "step", position: places.trigger!, selected: selected === "trigger", deletable: false,
      data: { title: "trigger", kind: "trigger", summary: triggerSummary(def.trigger, name), branching: false, trigger: true },
    },
    ...def.steps.map((s): FlowNode => ({
      id: s.id, type: "step", position: places[s.id]!, selected: selected === s.id, deletable: !readOnly,
      data: { title: s.name || s.id, kind: s.kind, summary: stepSummary(s, name, targetName), branching: BRANCHING.has(s.kind), trigger: false, ...(statuses?.[s.id] ? { status: statuses[s.id] } : {}) },
    })),
  ];
  const [nodes, setNodes] = useState<FlowNode[]>(build);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setNodes(build()), [def, selected, statuses]);
  const edges: FlowEdge[] = def.edges.map((e) => ({
    id: `${e.from}>${e.to}>${e.branch ?? ""}`, source: e.from, target: e.to, ...(e.branch ? { sourceHandle: e.branch, label: e.branch } : {}),
    markerEnd: { type: MarkerType.ArrowClosed }, deletable: !readOnly, className: e.branch ? `wf-edge-${e.branch}` : undefined,
  }));

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (readOnly) return;
    // A step dropped somewhere new keeps its place in the definition.
    const moved = changes.filter((c): c is Extract<NodeChange<FlowNode>, { type: "position" }> => c.type === "position" && c.dragging === false && !!c.position);
    if (!moved.length) return;
    let next = def;
    for (const c of moved) {
      const position = { x: Math.round(c.position!.x), y: Math.round(c.position!.y) };
      next = c.id === "trigger" ? { ...next, trigger: { ...next.trigger, position } } : { ...next, steps: next.steps.map((s) => (s.id === c.id ? { ...s, position } : s)) };
    }
    onChange!(next);
  };
  const onConnect = (c: Connection) => {
    if (!onChange || !c.source || !c.target) return;
    const out = connect(def, c.source, c.target, c.sourceHandle === "yes" || c.sourceHandle === "no" ? c.sourceHandle : undefined);
    if (typeof out === "string") onRefuse?.(out);
    else onChange(out);
  };

  return (
    <div className="wf-canvas" role="figure" aria-label={label}>
      <ReactFlow<FlowNode>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="dark" fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={(c) => !readOnly && typeof connect(def, c.source, c.target, c.sourceHandle === "yes" || c.sourceHandle === "no" ? c.sourceHandle : undefined) !== "string"}
        onNodeClick={(_e, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        onNodesDelete={(ns) => onChange && onChange(ns.reduce((d, n) => (n.id === "trigger" ? d : removeStep(d, n.id)), def))}
        onEdgesDelete={(es) => onChange && onChange({ ...def, edges: def.edges.filter((e) => !es.some((x) => x.id === `${e.from}>${e.to}>${e.branch ?? ""}`)) })}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
