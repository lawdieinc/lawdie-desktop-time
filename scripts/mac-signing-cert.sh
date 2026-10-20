#!/bin/sh
# Makes the self-signed certificate macOS builds are signed with, once, and stores it as
# the repo's MAC_CERT_P12 / MAC_CERT_PASSWORD secrets for the release workflow.
#
# Why: an ad hoc signature changes with every build, and macOS ties Screen Recording and
# Accessibility to it, so each update lost both (System Settings still showed them on).
# Signed with one certificate, macOS ties them to that certificate and they survive
# updates. It is not a Developer ID: Gatekeeper still asks for "Open Anyway" once.
#
# The key stays in ~/.lawdie-signing (back it up). Losing it means a new certificate,
# and every user grants the two permissions once more.
set -eu
DIR="$HOME/.lawdie-signing"
NAME="Lawdie Time Capture Signing"
if [ -f "$DIR/cert.p12" ]; then echo "$DIR/cert.p12 exists; not replacing it." >&2; exit 1; fi
mkdir -p "$DIR"; chmod 700 "$DIR"; cd "$DIR"
cat > cert.cnf <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$NAME
O=Lawdie
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -config cert.cnf
openssl rand -hex 24 > password.txt
# -legacy: macOS's security tool cannot read OpenSSL 3's default p12 encryption.
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -name "$NAME" -out cert.p12 -passout file:password.txt 2>/dev/null \
    || openssl pkcs12 -export -inkey key.pem -in cert.pem -name "$NAME" -out cert.p12 -passout file:password.txt
rm key.pem; chmod 600 ./*
base64 < cert.p12 | tr -d '\n' | gh secret set MAC_CERT_P12 --repo lawdieinc/lawdie-desktop-time
gh secret set MAC_CERT_PASSWORD --repo lawdieinc/lawdie-desktop-time < password.txt
echo "Made $DIR/cert.p12 and set MAC_CERT_P12 and MAC_CERT_PASSWORD. Back up $DIR."
