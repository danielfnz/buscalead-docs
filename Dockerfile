FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html docs.html /usr/share/nginx/html/
COPY contratacao/ /usr/share/nginx/html/contratacao/
COPY assets/ /usr/share/nginx/html/assets/
EXPOSE 80
