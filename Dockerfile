# One service, one origin: this image serves the API and the interface from the
# same port, so there is no API base URL to configure and no CORS to get wrong.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8000
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY cutoff/ ./cutoff/
COPY artifacts/dsr.json artifacts/benchmark.json artifacts/calibration.json ./artifacts/
COPY web/ ./web/

EXPOSE 8000
CMD ["sh", "-c", "uvicorn cutoff.api.main:app --host 0.0.0.0 --port ${PORT}"]
