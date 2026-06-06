#!/bin/bash
cd /Users/0ne29/MoreSalamander/myAIscript/backend
exec ./.venv/bin/uvicorn myAIscript.api:app --host 0.0.0.0 --port 8005
