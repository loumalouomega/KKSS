#!/bin/sh
set -eu
uv pip compile docker/kratos/requirements.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 --only-binary :all: --generate-hashes --output-file docker/kratos/requirements.lock
