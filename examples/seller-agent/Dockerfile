# Generic image for the example seller agent — intentionally free of any
# Kite-internal detail so it ships in the public bundle. Kite's own
# deployment of live instances lives outside public/ in the private repo.
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir . && \
    groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --no-create-home --shell /usr/sbin/nologin appuser

USER appuser
EXPOSE 9999
CMD ["python", "-m", "seller_agent"]
