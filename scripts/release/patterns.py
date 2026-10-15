"""Credential shapes the release path refuses to publish.

One definition, two callers: release/package.py refuses these bytes inside a source or native
archive, and release/check-secrets.py refuses them in the tracked tree and in the evidence a CI
run uploads. The engine's token format is fixed (see docs/SECURITY.md), so the shape is
recognisable without reading anything private.
"""
import re

SECRET = re.compile(rb'cg_[a-f0-9]{16}_[a-f0-9]{64}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
