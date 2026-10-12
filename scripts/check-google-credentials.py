#!/usr/bin/env python3
"""Small local credential probe. Requires Python 3 and gcloud; no gateway calls.

Usage: python3 scripts/check-google-credentials.py [https://gateway-test.invalid]
Exit 0: all checks passed; exit 1: a check failed; exit 2: invalid arguments.
Tokens stay in captured process output in memory, never in argv or files.
JWT decoding is inspection only: it does not verify the signature or issuer.
"""

import argparse
import base64
import json
import os
import subprocess
import time


def error_category(stderr):
    """Return fixed messages only: raw gcloud errors can contain credentials."""
    message = stderr.lower()
    for needles, description in (
        (("invalid account type", "requires a service account"),
         "Account type does not support this ID-token request."),
        (("default credentials were not found", "could not automatically determine credentials"),
         "ADC credentials not found."),
        (("no active account", "do not currently have an active account"),
         "No active gcloud account."),
        (("invalid_grant", "reauthentication", "reauth", "expired or revoked"),
         "Credentials expired, revoked, or require reauthentication."),
        (("permission denied", "permission_denied", "iam.serviceaccounts"),
         "Permission or service-account impersonation failure."),
        (("permissionerror", "errno 13", "read-only file system"),
         "Local filesystem permission failure."),
        (("connection", "name resolution", "proxy", "network", "ssl"),
         "Network, DNS, proxy, or TLS failure."),
    ):
        if any(needle in message for needle in needles):
            return description
    return "Unclassified gcloud failure; raw diagnostics suppressed for safety."


def run_gcloud(arguments, timeout):
    environment = os.environ.copy()
    environment.update({
        "CLOUDSDK_CORE_DISABLE_PROMPTS": "true",
        "CLOUDSDK_CORE_DISABLE_FILE_LOGGING": "true",
        "CLOUDSDK_CORE_LOG_HTTP": "false",
        "CLOUDSDK_CORE_VERBOSITY": "error",
    })
    try:
        result = subprocess.run(
            ["gcloud", "--quiet", "--verbosity=error", *arguments],
            stdin=subprocess.DEVNULL, capture_output=True, text=True,
            env=environment, timeout=timeout,
        )
    except FileNotFoundError:
        return None, "gcloud is not installed or is absent from PATH."
    except subprocess.TimeoutExpired:
        return None, "Command timed out ({} seconds).".format(timeout)
    except (OSError, UnicodeError):
        return None, "Cannot execute gcloud or decode its output."
    if result.returncode:
        return None, "Exit {}: {}".format(result.returncode, error_category(result.stderr))
    if not result.stdout.strip():
        return None, "Command succeeded but returned empty output."
    return result.stdout.strip(), None


def decode_part(part):
    value = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    if not isinstance(value, dict):
        raise ValueError("JWT section must be an object")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audience", nargs="?", default="https://gateway-test.invalid")
    args = parser.parse_args()
    timeout = 30
    print("Test audience: " + json.dumps(args.audience))
    print("Each gcloud command has a {}-second timeout.".format(timeout))

    account, error = run_gcloud(
        ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], timeout)
    print("\n1) Active gcloud account: " + (json.dumps(account) if account else error))

    token, error = run_gcloud(
        ["auth", "print-identity-token", "--audiences=" + args.audience], timeout)
    identity_ok = False
    print("\n2) CLI ID token with test audience: " + ("obtained; token hidden" if token else error))
    if token:
        try:
            header_part, payload_part, _ = token.split(".")
            header, claims = decode_part(header_part), decode_part(payload_part)
            print("3) Selected JWT fields (signature NOT verified):")
            print(json.dumps({
                "header": {key: header.get(key) for key in ("alg", "kid", "typ")},
                "claims": {key: claims.get(key) for key in
                           ("iss", "aud", "sub", "email", "email_verified", "iat", "exp")},
            }, indent=2, ensure_ascii=True))
            audience_ok = claims.get("aud") == args.audience
            expiry = claims.get("exp")
            expiry_ok = type(expiry) in (int, float) and expiry > time.time()
            identity_ok = audience_ok and expiry_ok
            print("Audience matches: {}; expiration is in the future: {}".format(audience_ok, expiry_ok))
        except (ValueError, TypeError, UnicodeError):
            print("3) Cannot decode JWT; token and raw errors suppressed.")
        token = None
    else:
        print("3) JWT decoding skipped: no ID token returned.")

    access_token, error = run_gcloud(
        ["auth", "application-default", "print-access-token"], timeout)
    adc_ok = access_token is not None
    access_token = None
    print("\n4) ADC access token: " + ("available; token hidden" if adc_ok else error))
    print("\n5) Observed: active CLI account={}; ID token with matching audience/expiry={}; ADC access token={}.".format(
        bool(account), identity_ok, adc_ok))
    print("CLI credentials and ADC are separate credential configurations.")
    print("ADC availability does not establish the ADC identity or support for a gateway ID token.")
    return 0 if account and identity_ok and adc_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
