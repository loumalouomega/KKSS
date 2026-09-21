FROM golang:1.27.1-bookworm AS builder
WORKDIR /web
COPY docker/web/go.mod docker/web/go.sum ./
RUN go mod download
COPY docker/web/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /kkss-web .
FROM debian:bookworm-slim
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /data && chown 1000:1000 /data
COPY --from=builder /kkss-web /opt/kkss-web
USER 1000:1000
ENV KKSS_BROKER=1 KKSS_GATEWAY_ADDR=0.0.0.0:6082
EXPOSE 6082
ENTRYPOINT ["/opt/kkss-web"]
