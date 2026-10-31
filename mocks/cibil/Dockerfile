FROM python:3.12.16-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WORKERS=2
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

RUN useradd --system --uid 10001 app
USER app
EXPOSE 8101
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port 8101 --workers $WORKERS --no-access-log"]
