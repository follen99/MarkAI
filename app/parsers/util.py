def unique_id(base_id: str, used_ids: set) -> str:
    unique = base_id
    suffix = 1
    while unique in used_ids:
        suffix += 1
        unique = f"{base_id}-{suffix}"
    used_ids.add(unique)
    return unique
