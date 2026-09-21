# syntax=docker/dockerfile:1
FROM filebrowser/filebrowser:v2.63.23
USER root
RUN mkdir -p /database /srv && chown -R 1000:1000 /database /srv
COPY --chmod=755 docker/files/entrypoint.sh /kkss-files.sh
USER 1000:1000
ENTRYPOINT ["/kkss-files.sh"]
HEALTHCHECK --interval=15s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8080${KKSS_BASE_PATH}/files/health || exit 1
