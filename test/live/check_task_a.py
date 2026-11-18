"""Check the proposed Task A helper read from stdin in the live test fixture."""

import ast
import re
import sys
from types import SimpleNamespace

source = ast.parse(sys.stdin.read())
helper, = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "get_debug_flag"]
environment = {}
scope = {"__builtins__": {}, "os": SimpleNamespace(environ=environment), "bool": bool}
assert not helper.decorator_list and ast.unparse(helper.args) == "", "unexpected helper signature"
allowed_attributes = {"environ", "get", "getenv", "lower", "casefold", "upper"}
allowed_nodes = {
    ast.FunctionDef, ast.arguments, ast.Expr, ast.Constant, ast.Name, ast.Load,
    ast.Store, ast.Assign, ast.Return, ast.Call, ast.Attribute, ast.BoolOp,
    ast.And, ast.Or, ast.Compare, ast.In, ast.NotIn, ast.Eq, ast.NotEq, ast.Is,
    ast.IsNot, ast.Set, ast.Tuple, ast.List, ast.If, ast.IfExp, ast.UnaryOp, ast.Not,
}
for node in ast.walk(helper):
    assert type(node) in allowed_nodes, f"unexpected helper syntax: {type(node).__name__}"
    if isinstance(node, ast.Attribute):
        assert node.attr in allowed_attributes, f"unexpected helper attribute: {node.attr}"
scope["os"].getenv = environment.get
exec(compile(ast.Module(body=[helper], type_ignores=[]), "<staged helper>", "exec"), scope)
false_values = ("", "0", "false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF", "n", "N")
true_values = ("1", "true", "TRUE", "yes", "on", "ON", "y", "Y", " ", " off")
assert scope["get_debug_flag"]() is False, "unset must be false"
for value, expected in [(value, False) for value in false_values] + [(value, True) for value in true_values]:
    environment["FLASK_DEBUG"] = value
    assert scope["get_debug_flag"]() is expected, repr(value)

doc = (ast.get_docstring(helper) or "").lower().replace("\n", " ")
assert re.search(r"\b(?:unset|not set|missing|undefined|absent)\b", doc), "docstring omits unset"
assert re.search(r"\bempty\b|[\x27\x22]{2}", doc), "docstring omits empty"
for value in ("0", "false", "no", "off", "n"):
    assert re.search(rf"[`\x27\x22]+{value}[`\x27\x22]+|\b{value}\b", doc), f"docstring omits {value}"
print("Task A: 24 behavior cases and documentation checks passed.")
