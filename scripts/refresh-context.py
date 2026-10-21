#!/usr/bin/env python3
"""Refresh explicitly configured sources; never reads credentials from project files."""
import argparse
import json
import os
import datetime as dt
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'src'))
from context_refresh import refresh

if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    root = Path(__file__).resolve().parent.parent
    if root == Path(args.output).resolve() or root in Path(args.output).resolve().parents:
        parser.error('Output must be a private directory outside the checkout')
    if config.get('rollingWindow'):
        now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
        start = (now - dt.timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
        config.update(start=start.isoformat(), end=(start + dt.timedelta(days=15)).isoformat())
    from context_refresh import timestamp
    if not timestamp(config.get('start')) or not timestamp(config.get('end')):
        parser.error('Calendar window requires explicit timezone')
    start, end = (dt.datetime.fromisoformat(config[k].replace('Z', '+00:00')) for k in ('start', 'end'))
    if not dt.timedelta(0) < end - start <= dt.timedelta(days=31):
        parser.error('Calendar window must be positive and at most 31 days')
    result = refresh(config, args.output)
    print(json.dumps(dict(status=result['status'], coverage=result['coverage'], events=len(result['events']),
        candidates=len(result['candidates']), documents=len(result['documents']), modelCost=result['modelCost']), ensure_ascii=False))
