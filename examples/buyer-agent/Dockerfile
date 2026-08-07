# Generic image for the example buyer agent — intentionally free of any
# Kite-internal detail so it ships in the public bundle. Kite's own
# deployment of live instances lives outside public/ in the private repo.
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

CMD ["python", "-m", "buyer_agent"]
