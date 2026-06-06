#!/bin/bash
cd /Users/0ne29/MoreSalamander/myAIbeats/backend
exec ./.venv/bin/uvicorn myAIbeats.api:app --host 0.0.0.0 --port 8006
