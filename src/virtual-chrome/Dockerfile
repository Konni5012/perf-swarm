FROM --platform=linux/amd64 debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg xvfb socat procps \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home swarm
COPY start.sh /usr/local/bin/perf-swarm-chrome
RUN chmod 755 /usr/local/bin/perf-swarm-chrome
USER swarm
ENV DISPLAY=:99
ENTRYPOINT ["/usr/local/bin/perf-swarm-chrome"]
