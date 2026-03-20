# Vertex Anthropic Provider for VS Code

This is a proof of concept extension that adds Claude 4.6 Opus from Google Cloud Vertex AI as a language model chat provider in VS Code.

## Usage
Select the `@vertex-anthropic` model in the Copilot Chat view to send messages to Claude.

## Requirements
You must have standard application-default credentials configured (`gcloud auth application-default login`) and configure your GCP project ID and region in the VS Code settings (`vertexAnthropic.projectId` and `vertexAnthropic.region`).
