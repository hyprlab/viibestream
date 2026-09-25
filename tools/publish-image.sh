#!/usr/bin/env bash
# Build the Docker image for a tagged version and push it to Docker Hub.
#
#   tools/publish-image.sh 0.5.0     # pushes :0.5.0, :0.5 and :latest
#
# Builds from the tag, not the working tree, so what is pushed is exactly what
# was released. linux/amd64 only by default: the host's buildx has no arm64
# builder. Set PLATFORMS=linux/amd64,linux/arm64 once it does.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: tools/publish-image.sh X.Y.Z}"
TAG="v$VERSION"
IMAGE="${IMAGE:-hyprlab/viibestream}"
PLATFORMS="${PLATFORMS:-linux/amd64}"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG" >&2; exit 1; }
tagged=$(git show "$TAG:app/config.py" | sed -nE 's/^\s*APP_VERSION = "(.*)"/\1/p')
[ "$tagged" = "$VERSION" ] || { echo "$TAG carries APP_VERSION $tagged, not $VERSION" >&2; exit 1; }

tags=(-t "$IMAGE:$VERSION" -t "$IMAGE:${VERSION%.*}" -t "$IMAGE:latest")

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git archive "$TAG" | tar -x -C "$src"

echo "Building $IMAGE for $VERSION ($PLATFORMS) from $TAG"
docker buildx build --platform "$PLATFORMS" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$(git rev-parse "$TAG^{commit}")" \
    --label "org.opencontainers.image.source=https://github.com/$IMAGE" \
    "${tags[@]}" --push "$src"

echo "Pushed: ${tags[*]//-t /}"
