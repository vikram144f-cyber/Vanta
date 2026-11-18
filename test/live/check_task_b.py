"""Check Task B from a staged snapshot or the explicitly saved checkout."""

import json
import pathlib
import re
import subprocess
import sys
import tempfile

import flask


def main():
    root = pathlib.Path.cwd()
    imported = pathlib.Path(flask.__file__).resolve()
    assert imported.is_relative_to(root / "src"), imported
    public = {"DEMO_PUBLIC": "visible", "DEMO_VERBOSE": True, "DEMO_NUMBER": 42}
    secret = {
        "DEMO_SECRET": "synthetic-e",
        "DEMO_PASSWORD": "synthetic-f",
        "DEMO_TOKEN": "synthetic-g",
        "DEMO_KEY": "synthetic-h",
        "mySeCrEt": "synthetic-a",
        "DemoPassword": "synthetic-b",
        "demo_token_suffix": "synthetic-c",
        "preKeyPost": "synthetic-d",
    }
    with tempfile.TemporaryDirectory(prefix="vanta-task-b-") as work:
        app = pathlib.Path(work) / "taskb_demo.py"
        app.write_text(
            "from datetime import timedelta\nfrom flask import Flask\n"
            f"app = Flask(__name__)\napp.config.update({public | secret!r})\n"
            "app.config['DEMO_DURATION'] = timedelta(seconds=75)\n"
            "app.add_url_rule('/task-b-route', 'task_b_route', lambda: 'ok')\n",
            encoding="utf-8",
        )
        command = [sys.executable, "-m", "flask", "--app", str(app)]
        help_text = subprocess.check_output([*command, "--help"], text=True)
        description = next(
            (
                line.strip()
                for line in help_text.splitlines()
                if line.strip().split()[:1] == ["config"]
            ),
            None,
        )
        assert description, "flask --help did not list config. Check that the approved files were saved."
        routes = subprocess.check_output([*command, "routes"], text=True)
        assert any(row.split() == ["task_b_route", "GET", "/task-b-route"]
                   for row in routes.splitlines()), routes
        output = subprocess.check_output([*command, "config"], text=True)
        data = json.loads(output)
    for key, value in public.items():
        assert data[key] == value, key
    for key, value in secret.items():
        assert data[key] == "***" and value not in output, key
    for key, value in data.items():
        if any(part in key.upper() for part in ("SECRET", "PASSWORD", "TOKEN", "KEY")):
            assert value == "***", key
    assert data["DEMO_DURATION"] is not None
    docs = (root / "docs" / "cli.rst").read_text(encoding="utf-8")
    headings = list(re.finditer(r"^([^\s][^\n]*)\n-{3,}[ \t]*$", docs, re.MULTILINE))
    titles = [heading[1] for heading in headings]
    # Built-ins can be documented immediately before, between, or after the existing peers.
    after_discovery = titles.index("Application Discovery") + 1
    dotenv = titles.index("Environment Variables From dotenv")
    built_in_sections = docs[headings[after_discovery].start() : headings[dotenv].start()]
    assert re.search(
        r"\bflask(?:[ \t]+--app(?:[ \t]+|=)\S+)?[ \t]+config\b", built_in_sections
    ), "The flask config example belongs alongside the run and shell sections."
    print(f"Flask source: {imported.relative_to(root)}")
    print(f"CLI help: {description}")
    print(json.dumps({key: data[key] for key in (*public, *secret, "DEMO_DURATION")}, sort_keys=True))


if __name__ == "__main__":
    main()
