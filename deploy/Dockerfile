FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libxrender1 libxext6 libsm6 libexpat1 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY deploy/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY chemistry.py /app/chemistry.py
COPY deploy /app/deploy
RUN python -c "import chemistry; assert chemistry.process({'action':'inspect','smiles':'O'})['valid']"
RUN useradd --system --uid 10001 orbital
USER orbital
EXPOSE 8000
CMD ["python", "-m", "deploy.run_cloud"]
