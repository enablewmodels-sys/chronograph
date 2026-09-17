"""Validate OpenAPI syntax and fail when the checked-in server contract drifts."""
import json
import subprocess
from pathlib import Path
from openapi_spec_validator import validate
root=Path(__file__).resolve().parents[2]
expected=json.loads((root/'sdk/schema/openapi.json').read_text())
actual=json.loads(subprocess.check_output(['cargo','run','--locked','--quiet','-p','chronograph-server','--example','export_openapi'],cwd=root))
assert actual==expected,'Regenerate sdk/schema/openapi.json from the Rust exporter'
validate(actual)
print(f"PASS OpenAPI 3.1: {len(actual['paths'])} paths, shared MCP input schemas, no contract drift")
