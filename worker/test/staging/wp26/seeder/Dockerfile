# WP2.6 staging (test code): the seeder, the server image plus seed.py. run.sh builds the server
# image as cfo-wp26-server:dev from images/server/Dockerfile before the deploy.
ARG SERVER_IMAGE=cfo-wp26-server:dev
FROM ${SERVER_IMAGE}
COPY seed.py /opt/wp26/seed.py
EXPOSE 8080
CMD ["python", "/opt/wp26/seed.py"]
