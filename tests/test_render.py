"""Exercise the real render/broker code with a mocked ComfyUI transport."""
import ast
import json
from pathlib import Path
import threading
import types
import unittest
import uuid


class RenderRoutingTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "nodes.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        classes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
        self.server = types.SimpleNamespace(client_id="origin", sockets={"origin": object(), "other": object()})
        self.env = dict(threading=threading, json=json, uuid=uuid,
                        PromptServer=types.SimpleNamespace(instance=self.server))
        exec(compile(ast.Module(body=classes, type_ignores=[]), str(source), "exec"), self.env)
        self.env["BROKER"] = self.env["_RenderBroker"]()
        self.calls = []

        def send(event, payload, sid=None):
            self.calls.append((event, payload, sid))
            # Fail deliberately after dispatch, avoiding image-library dependencies.
            job = self.env["BROKER"].get(payload["token"])
            job.error = "render reached intended client"
            job.event.set()

        self.server.send_sync = send

    def render(self):
        return self.env["GS3DSceneRender"]().render(
            "queued.ply", 512, 5, json.dumps({"cameras": [{}]}),
            mesh=["queued.glb"], unique_id="42")

    def test_targets_origin_and_preserves_execution_inputs(self):
        with self.assertRaisesRegex(RuntimeError, "render reached intended client"):
            self.render()
        self.assertEqual(len(self.calls), 1)
        event, data, sid = self.calls[0]
        self.assertEqual(sid, "origin")
        self.assertEqual(data["gs_model"], "queued.ply")
        self.assertEqual(data["meshes"], ["queued.glb"])
        self.assertIsNone(self.env["BROKER"].get(data["token"]))

    def test_disconnected_origin_does_not_fall_back_to_other_tab(self):
        del self.server.sockets["origin"]
        with self.assertRaisesRegex(RuntimeError, "実行元"):
            self.render()
        self.assertEqual(self.calls, [])

    def test_missing_api_client_does_not_broadcast(self):
        self.server.client_id = None
        with self.assertRaisesRegex(RuntimeError, "client_id"):
            self.render()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
