#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize the approved ConflictStudio catalog in an empty catalog."
    )
    parser.add_argument(
        "--data-root",
        type=Path,
        required=True,
        help="Existing ConflictStudio data root.",
    )
    return parser.parse_args()


def main() -> int:
    from backend.adapters.database import Database
    from backend.services.catalog_seed import (
        CatalogSeedError,
        CatalogSeedInitializer,
    )

    args = parse_args()
    database = Database(args.data_root)
    database.initialize()
    try:
        counts = CatalogSeedInitializer(database).initialize()
    except CatalogSeedError as error:
        print(str(error))
        return 1
    print(json.dumps(counts, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
