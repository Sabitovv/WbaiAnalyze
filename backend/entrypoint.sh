#!/bin/sh
set -e

echo "Running migrations..."
node migrate.js

echo "Starting server..."
exec node index.js
