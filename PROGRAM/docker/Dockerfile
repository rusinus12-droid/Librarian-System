# Librarian System server in a container.
# Build in the package root (the folder that holds PROGRAM and DATA):
#   docker build -f PROGRAM/docker/Dockerfile -t librarian-system .
# Or use PROGRAM/docker/compose.yaml. The guide is PROGRAM/서버_사용과_접속_관련_상세_안내.txt.
FROM node:22-bookworm-slim
ENV LIBRARIAN_HOME=/librarian
WORKDIR /librarian
# Only PROGRAM goes into the image. DATA is a volume, so the image never carries anyone's memories.
COPY PROGRAM ./PROGRAM
RUN node --no-warnings PROGRAM/tools/check_node.cjs \
 && install -m 0755 PROGRAM/docker/entrypoint.sh /usr/local/bin/librarian-entrypoint \
 && mkdir -p DATA && chown node:node DATA
USER node
VOLUME ["/librarian/DATA"]
EXPOSE 47630
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const p=require('/librarian/DATA/config/server-config.json').port;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["librarian-entrypoint"]
