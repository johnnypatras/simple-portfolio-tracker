#!/bin/bash
cd "$(dirname "$0")"
mkdir -p diagrams

for f in mermaid/*.mmd; do
  name=$(basename "$f" .mmd)
  echo "Rendering $name..."
  npx -y @mermaid-js/mermaid-cli -i "$f" -o "diagrams/${name}.png" -b transparent -w 800 --scale 2 2>/dev/null
done
echo "Done: $(ls diagrams/*.png 2>/dev/null | wc -l) diagrams rendered"
