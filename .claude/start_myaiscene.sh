#!/bin/bash
cd /Users/0ne29/MoreSalamander/myAIscene/backend
exec ./.venv/bin/uvicorn myAIscene.api:app --host 0.0.0.0 --port 8004
