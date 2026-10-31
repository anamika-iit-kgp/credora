FROM python:3.12.16-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DDL_DIR=/app/db
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY generator ./generator
# DDL comes from the repo's db/ folder, passed as the named build context "db"
COPY --from=db *.sql ./db/

RUN useradd --system --uid 10001 app
USER app
EXPOSE 8100
CMD ["uvicorn", "generator.app:app", "--host", "0.0.0.0", "--port", "8100"]
