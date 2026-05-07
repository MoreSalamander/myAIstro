import uuid
from datetime import datetime


class Node:
    def __init__(self, name, func, depends_on=None):
        self.node_id = str(uuid.uuid4())
        self.name = name
        self.func = func
        self.depends_on = depends_on or []
        self.status = "pending"
        self.output = None

    def run(self, context):
        self.status = "running"
        self.output = self.func(context)
        self.status = "completed"
        return self.output


class Task:
    def __init__(self, input_data):
        self.task_id = str(uuid.uuid4())
        self.created_at = datetime.utcnow().isoformat()
        self.status = "pending"
        self.input = input_data
        self.nodes = []
        self.context = {}

    def add_node(self, node):
        self.nodes.append(node)

    def run(self):
        self.status = "running"

        for node in self.nodes:
            # dependency check (v1 simple)
            if node.depends_on:
                for dep in node.depends_on:
                    if dep.status != "completed":
                        raise Exception(f"Dependency not met for {node.name}")

            result = node.run(self.context)
            self.context[node.name] = result

            # -------------------------
            # VALIDATION GATE
            # -------------------------
            if node.name == "validation":
                if result.get("validation") == "FAIL":
                    self.status = "failed"
                    return {
                        "task_id": self.task_id,
                        "status": "failed",
                        "context": self.context
                    }
