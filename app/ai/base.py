from abc import ABC, abstractmethod


class AIProvider(ABC):
    """Extension point for the future in-app 'Resolve with AI' feature.

    A concrete provider (e.g. an OpenAI/Anthropic-style hosted API, or a local
    Ollama server) will implement `resolve` to take a note plus the document it
    was made on and propose/apply a fix, without going through the source-folder
    JSON export/import loop. None of this is wired up to actually run yet -
    `resolve_with_provider` below always returns "not implemented" - but the
    settings storage (`ai_providers` table) and this interface are in place so a
    real implementation can be dropped in later.
    """

    kind: str  # "api" or "local"

    def __init__(self, config: dict):
        self.config = config

    @abstractmethod
    def resolve(self, note: dict, document: dict) -> dict:
        """Given a note and the document it belongs to, produce a proposed fix.

        Should return a dict describing the outcome (implementation-defined).
        """
        raise NotImplementedError


def resolve_with_provider(provider_row, note: dict, document: dict) -> dict:
    """Placeholder entry point used by the /notes/<id>/resolve-ai endpoint.

    Once concrete AIProvider subclasses exist (e.g. for 'api' / 'local' kinds),
    this function should look up the right one by provider_row['kind'] and call
    .resolve(). For now it always signals that the feature isn't built yet.
    """
    raise NotImplementedError("Resolve with AI is not implemented yet.")
