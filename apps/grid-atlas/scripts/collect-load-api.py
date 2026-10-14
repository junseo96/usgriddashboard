#!/usr/bin/env python3
"""Refresh public load API observations; --check validates without network."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

from load_api import CollectionError, collect, strict_json, validate_dataset

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/load-api-observations.json')
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.local/load-api')
    parser.add_argument('--check', action='store_true', help='validate current dataset without acquisition')
    args = parser.parse_args()
    try:
        if args.check:
            data = validate_dataset(strict_json(args.output.read_bytes()))
            print(f'Validated {len(data["records"])} append-only ERCOT aggregate API report observations; collection status {data["collection"]["status"]}.')
            return 0
        code, data = collect(args.output, args.state_dir)
        run = data['collection']
        print(f'Load API collection {run["status"]}: {run["addedCount"]} new observations, {len(data["records"])} preserved total; completed {run["completedAt"]}.')
        if run['error']:
            print(run['error'], file=sys.stderr)
        for warning in run['warnings']:
            print(warning)
        return code
    except (CollectionError, OSError) as exc:
        print(f'Load API validation/acquisition failed: {exc}', file=sys.stderr)
        return 1
    except Exception as exc:
        print(f'Unexpected load API failure ({type(exc).__name__})', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
