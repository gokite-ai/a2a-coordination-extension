# Generic image for the public example buyer agent. Production deployment
# configuration is intentionally out of scope for this example.
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir . && \
    groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --no-create-home --shell /usr/sbin/nologin appuser

USER appuser
CMD ["python", "-m", "buyer_agent"]
