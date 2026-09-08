import ast
import os
from pathlib import Path
import tempfile
import types
import unittest
import uuid


class Field:
    name = "file"

    def __init__(self, name):
        self.filename = name
        self.body = b"sample"

    async def read_chunk(self, size):
        value, self.body = self.body, b""
        return value


class Request:
    def __init__(self, names):
        self.names = names

    async def multipart(self):
        async def fields():
            for name in self.names:
                yield Field(name)
        return fields()


class ObjUploadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        source = Path(__file__).resolve().parents[1] / "nodes.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_gs3d_upload_obj")
        function.decorator_list = []
        env = dict(os=os, tempfile=tempfile, uuid=uuid, UPLOAD_SUBDIR="3d",
                   folder_paths=types.SimpleNamespace(get_input_directory=lambda: self.temp.name),
                   web=types.SimpleNamespace(json_response=lambda data, status=200: (status, data)))
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), env)
        self.upload = env[function.name]

    async def test_bundle_preserves_filenames_without_overwriting_previous_upload(self):
        names = ["Test2.obj", "Test2.mtl", "tex_u1_v1_diffuse.jpg", "tex_u1_v1_normal.jpg"]
        first = await self.upload(Request(names))
        second = await self.upload(Request(names))
        self.assertEqual(first[0], 200)
        self.assertEqual(second[0], 200)
        self.assertNotEqual(first[1]["name"], second[1]["name"])
        directory = (Path(self.temp.name) / first[1]["name"]).parent
        self.assertEqual(sorted(p.name for p in directory.iterdir()), sorted(names))

    async def test_rejected_bundles_leave_no_partial_files(self):
        for names in (["Test2.obj", "../image.jpg"], ["a.obj", "b.obj"],
                      ["image.jpg"], ["a.obj", "a.mtl", "A.mtl"]):
            result = await self.upload(Request(names))
            self.assertEqual(result[0], 400)
            self.assertEqual(list((Path(self.temp.name) / "3d").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
