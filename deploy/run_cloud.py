"""Provider-neutral launcher; Render/Railway supply PORT at runtime."""
import os
import uvicorn

if __name__ == "__main__":
    uvicorn.run("deploy.cloud_api:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
                workers=1, lifespan="on", access_log=False,
                limit_concurrency=32, timeout_keep_alive=5)
