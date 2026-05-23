"""
Execution Engine — a tiny task-graph runner.

Used by the legacy `/query` endpoint in main.py to chain
retrieval → summarization → validation as three Nodes with explicit
`depends_on` edges. The modern ingestion path uses
`core/ingestion_pipeline.py` directly as a generator and doesn't need
this — but the demo endpoint shows the underlying composition pattern.

Behavior:
  - Nodes execute in the order they were added.
  - A Node with `depends_on` raises if any dependency hasn't completed.
  - The Task collects each node's output into a shared `context` dict
    so later nodes can read earlier results.
  - The validation gate is hardcoded: if a node named "validation"
    returns `validation: FAIL`, the task aborts immediately. This is
    the same gate idea used in the modern pipeline, expressed as a
    runtime convention here.
"""

import uuid
from datetime import datetime


class Node:
    """
    One step in the task graph.

    `func` is called with the shared context dict and returns the
    node's output, which is stored under `self.output` and merged
    into the task context under the node's `name`.
    """

    def __init__(self, name, func, depends_on=None):
        self.node_id = str(uuid.uuid4())
        self.name = name
        self.func = func
        self.depends_on = depends_on or []
        self.status = "pending"
        self.output = None

    def run(self, context):
        """Execute the node's function against the shared context."""
        self.status = "running"
        self.output = self.func(context)
        self.status = "completed"
        return self.output


class Task:
    """
    A task is an ordered set of Nodes that share a context dict.

    Build one with `Task(input_data=...)`, attach Nodes via
    `add_node(...)`, then call `run()` to execute the chain.
    """

    def __init__(self, input_data):
        self.task_id = str(uuid.uuid4())
        self.created_at = datetime.utcnow().isoformat()
        self.status = "pending"
        self.input = input_data
        self.nodes = []
        self.context = {}

    def add_node(self, node):
        """Append a node to the execution order."""
        self.nodes.append(node)

    def run(self):
        """Execute every node in order, honoring dependencies and the validation gate."""
        self.status = "running"

        for node in self.nodes:
            # Dependency check: every node listed in depends_on must
            # already have status == "completed" before this node runs.
            if node.depends_on:
                for dep in node.depends_on:
                    if dep.status != "completed":
                        raise Exception(f"Dependency not met for {node.name}")

            result = node.run(self.context)
            self.context[node.name] = result

            # Validation gate — same idea as the streaming pipeline's
            # memory_write gate. A node named "validation" that returns
            # `validation: FAIL` halts the task immediately; downstream
            # nodes don't run.
            if node.name == "validation":
                if result.get("validation") == "FAIL":
                    self.status = "failed"
                    return {
                        "task_id": self.task_id,
                        "status": "failed",
                        "context": self.context,
                    }
