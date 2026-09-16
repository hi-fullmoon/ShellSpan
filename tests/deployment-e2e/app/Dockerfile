FROM alpine:3.22

ARG HEALTH_STATUS=200
ENV HEALTH_STATUS=$HEALTH_STATUS

RUN apk add --no-cache python3

COPY server.py /srv/server.py

EXPOSE 8080

CMD ["python3", "/srv/server.py"]
