# The probe's container: busybox serving a fixed /health on port 8080.
FROM busybox:1.37
RUN mkdir /www && echo ok > /www/health
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
