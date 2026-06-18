FROM qwertyuiop8899/tvvoo:latest

# Beamup ascolta su 5000 di default (vedi log: "port listening check" port=5000)
# Non cambiare a 7860/8000/10000 su beamup — causerà healthcheck failure
ENV PORT=5000
EXPOSE 5000
CMD ["node", "dist/addon.js"]
