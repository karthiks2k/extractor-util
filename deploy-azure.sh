#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP}"
: "${AZURE_WEBAPP_NAME:?Set AZURE_WEBAPP_NAME (must be globally unique)}"
: "${AZURE_ACR_NAME:?Set AZURE_ACR_NAME (5-50 lowercase letters and numbers)}"

AZURE_LOCATION="${AZURE_LOCATION:-eastus}"
AZURE_PLAN_NAME="${AZURE_PLAN_NAME:-extractor-util-plan}"
DEPLOY_WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-600}"
IMAGE_NAME="extractor-util"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="$AZURE_ACR_NAME.azurecr.io/$IMAGE_NAME:$IMAGE_TAG"

if [[ ! "$AZURE_ACR_NAME" =~ ^[a-z0-9]{5,50}$ ]]; then
  echo "AZURE_ACR_NAME must be 5-50 lowercase letters and numbers." >&2
  exit 1
fi

if [[ ! "$DEPLOY_WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "DEPLOY_WAIT_SECONDS must be a positive number of seconds." >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI (az) is required." >&2
  exit 1
fi

az account show >/dev/null

az group create \
  --name "$AZURE_RESOURCE_GROUP" \
  --location "$AZURE_LOCATION" \
  --output none

if ! az acr show \
  --name "$AZURE_ACR_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  >/dev/null 2>&1; then
  az acr create \
    --name "$AZURE_ACR_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --sku Basic \
    --admin-enabled false \
    --output none
fi

# App Service managed-identity pulls require ACR ARM audience authentication.
az acr config authentication-as-arm update \
  --registry "$AZURE_ACR_NAME" \
  --status enabled \
  --output none

az acr build \
  --registry "$AZURE_ACR_NAME" \
  --image "$IMAGE_NAME:$IMAGE_TAG" \
  --file Dockerfile \
  .

if ! az appservice plan show \
  --name "$AZURE_PLAN_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  >/dev/null 2>&1; then
  az appservice plan create \
    --name "$AZURE_PLAN_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --sku B1 \
    --is-linux \
    --output none
fi

if ! az webapp show \
  --name "$AZURE_WEBAPP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  >/dev/null 2>&1; then
  az webapp create \
    --name "$AZURE_WEBAPP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --plan "$AZURE_PLAN_NAME" \
    --runtime "NODE:20-lts" \
    --output none
fi

PRINCIPAL_ID=$(az webapp identity assign \
  --name "$AZURE_WEBAPP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query principalId \
  --output tsv)
ACR_ID=$(az acr show \
  --name "$AZURE_ACR_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query id \
  --output tsv)

if ! az role assignment list \
  --assignee "$PRINCIPAL_ID" \
  --scope "$ACR_ID" \
  --role AcrPull \
  --query "[].id" \
  --output tsv | grep -q .; then
  az role assignment create \
    --assignee-object-id "$PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --scope "$ACR_ID" \
    --role AcrPull \
    --output none
fi

az webapp config set \
  --name "$AZURE_WEBAPP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --generic-configurations '{"acrUseManagedIdentityCreds": true}' \
  --output none

az webapp config container set \
  --name "$AZURE_WEBAPP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --container-image-name "$IMAGE" \
  --container-registry-url "https://$AZURE_ACR_NAME.azurecr.io" \
  --output none

az webapp config appsettings set \
  --name "$AZURE_WEBAPP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --settings \
    PORT=8080 \
    WEBSITES_PORT=8080 \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE=false \
    WEBSITES_CONTAINER_START_TIME_LIMIT=600 \
  --output none

az webapp restart \
  --name "$AZURE_WEBAPP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP"

APP_URL="https://$AZURE_WEBAPP_NAME.azurewebsites.net"
deadline=$((SECONDS + DEPLOY_WAIT_SECONDS))
until curl --silent --show-error --fail --output /dev/null "$APP_URL/"; do
  if (( SECONDS >= deadline )); then
    echo "App did not become ready within ${DEPLOY_WAIT_SECONDS}s: $APP_URL" >&2
    echo "Check the App Service container logs and ACR image-pull permissions." >&2
    exit 1
  fi
  sleep 10
done

echo "Deployed to https://$AZURE_WEBAPP_NAME.azurewebsites.net"
