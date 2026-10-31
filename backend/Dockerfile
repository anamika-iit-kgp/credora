FROM python:3.12.16-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# The Exasol MCP server for "Ask Credora", in its own virtual environment; the API starts it over stdio.
COPY requirements-mcp.txt .
RUN python -m venv /opt/exasol-mcp \
    && /opt/exasol-mcp/bin/pip install --no-cache-dir -r requirements-mcp.txt \
    && ln -s /opt/exasol-mcp/bin/exasol-mcp-server /usr/local/bin/exasol-mcp-server
COPY app ./app

RUN useradd --system --uid 10001 --create-home app
USER app
EXPOSE 8000
# One worker: analysis, training and generation jobs live in this process's memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-access-log"]
