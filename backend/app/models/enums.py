import enum


class UserRole(enum.StrEnum):
    ROOT = "ROOT"
    ADMIN = "ADMIN"
    USER = "USER"


class ServerStatus(enum.StrEnum):
    PENDING = "PENDING"
    ONLINE = "ONLINE"
    OFFLINE = "OFFLINE"
    UNREACHABLE = "UNREACHABLE"
    UNSUPPORTED = "UNSUPPORTED"


class ProviderType(enum.StrEnum):
    AMNEZIA_WG = "amnezia_wg"
    WG_EASY = "wg_easy"
    WIREGUARD = "wireguard"


class DeviceType(enum.StrEnum):
    PC = "PC"
    PHONE = "PHONE"
    ROUTER = "ROUTER"


class AuditAction(enum.StrEnum):
    LOGIN = "LOGIN"
    LOGIN_FAILED = "LOGIN_FAILED"
    LOGOUT = "LOGOUT"
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    DOWNLOAD = "DOWNLOAD"
    RECREATE = "RECREATE"
    DETECT = "DETECT"


class AuditTargetType(enum.StrEnum):
    SERVER = "SERVER"
    ORG = "ORG"
    USER = "USER"
    CONFIG = "CONFIG"
