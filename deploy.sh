#!/usr/bin/env bash
# ==============================================================================
# deploy.sh
# Compiles the 3 modular Coding Agent Gateway proxies
# (claude-code-gateway, antigravity-gateway, codex-gateway) for a selected
# stage (05..07, default 07-mvp-pilot) into complete Apigee X XML proxy bundles.
# Infrastructure and proxy deployment to Google Cloud Apigee X is managed
# declaratively via Terraform (`infra/`).
#
# Usage:
#   ./deploy.sh [--stage 07-mvp-pilot] [--build-only]
#
# Build-time parameter overrides (optional): STAGE_PARAMS='{"Name":"value",...}' sets or
# replaces any feature/stage parameter, e.g. the classifier URL of stage 06. A name that no
# feature declares under defaultParameters fails the build.
# ==============================================================================
set -euo pipefail

STAGE="07-mvp-pilot"
BUILD_ONLY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="$2"
      shift 2
      ;;
    --build-only)
      BUILD_ONLY="true"
      shift
      ;;
    05-*|06-*|07-*)
      STAGE="$1"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./deploy.sh [--stage <stage-name>] [--build-only]"
      exit 1
      ;;
  esac
done

STAGE_FILE="stages/${STAGE}.yaml"
if [[ ! -f "${STAGE_FILE}" ]]; then
  echo "Error: Stage file '${STAGE_FILE}' not found."
  exit 1
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-placeholder-gcp-project}}"
MODEL_ARMOR_REGION="${MODEL_ARMOR_REGION:-us-central1}"
MODEL_ARMOR_TEMPLATE_ID="${MODEL_ARMOR_TEMPLATE_ID:-coding-agent-armor-prod}"

BUILD_DIR="build/${STAGE}"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

echo "=================================================================="
echo " Building Apigee X Enterprise AI Gateway Stage: ${STAGE}"
echo " Target Proxies: claude-code-gateway, antigravity-gateway, codex-gateway"
echo "=================================================================="

PYTHON_BIN="python3"
if [[ -x "/usr/bin/python3" ]]; then
  PYTHON_BIN="/usr/bin/python3"
fi

"${PYTHON_BIN}" - "${STAGE_FILE}" "${BUILD_DIR}" "${GCP_PROJECT_ID}" "${MODEL_ARMOR_REGION}" "${MODEL_ARMOR_TEMPLATE_ID}" << 'PYEOF'
import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape


class SimpleYAMLParserError(Exception):
    pass


def _strip_inline_comment(line):
    in_single = False
    in_double = False
    for idx, ch in enumerate(line):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            if idx == 0 or line[idx - 1].isspace():
                return line[:idx].rstrip()
    return line.rstrip()


def _parse_scalar(val):
    val = val.strip()
    if val == "[]":
        return []
    if val == "{}":
        return {}
    if val in ("true", "True"):
        return True
    if val in ("false", "False"):
        return False
    if val in ("null", "None", "~"):
        return None
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        return val[1:-1]
    if re.match(r"^-?\d+$", val):
        return int(val)
    return val


def parse_yaml_file(path):
    with open(path, "r", encoding="utf-8") as f:
        raw_lines = f.readlines()

    tokens = []
    i = 0
    n = len(raw_lines)
    while i < n:
        raw = raw_lines[i]
        cleaned = _strip_inline_comment(raw.rstrip("\r\n"))
        if not cleaned.strip():
            i += 1
            continue
        indent = len(cleaned) - len(cleaned.lstrip(" "))
        content = cleaned.strip()

        if not content.startswith("-"):
            m_bad = re.match(r"^([A-Za-z0-9_.-]+):(\S.*)$", content)
            if m_bad and not content.startswith("http:") and not content.startswith("https:") and not content.startswith("jsc:"):
                raise SimpleYAMLParserError(
                    f"{path}:{i + 1}: Missing space after colon in '{content}'"
                )

        if content.endswith("|") or content.endswith(">-") or content.endswith(">"):
            fold = content.endswith(">-") or content.endswith(">")
            prefix = content[:-2].rstrip() if content.endswith(">-") else content[:-1].rstrip()
            block_lines = []
            i += 1
            block_indent = None
            while i < n:
                b_raw = raw_lines[i].rstrip("\r\n")
                if not b_raw.strip():
                    block_lines.append("")
                    i += 1
                    continue
                b_ind = len(b_raw) - len(b_raw.lstrip(" "))
                if block_indent is None:
                    if b_ind <= indent:
                        break
                    block_indent = b_ind
                if b_ind < block_indent:
                    break
                block_lines.append(b_raw[block_indent:])
                i += 1
            text_val = " ".join(x.strip() for x in block_lines if x.strip()) if fold else "\n".join(block_lines)
            tokens.append((indent, prefix, text_val, i))
            continue

        tokens.append((indent, content, None, i + 1))
        i += 1

    def parse_node(idx, expected_indent):
        if idx >= len(tokens):
            return None, idx
        ind, content, block_val, line_no = tokens[idx]
        if ind != expected_indent:
            raise SimpleYAMLParserError(
                f"{path}:{line_no}: Unexpected indentation {ind} (expected {expected_indent}) at '{content}'"
            )

        if content.startswith("- ") or content == "-":
            result_list = []
            while idx < len(tokens):
                ind, content, block_val, line_no = tokens[idx]
                if ind < expected_indent:
                    break
                if ind != expected_indent:
                    raise SimpleYAMLParserError(
                        f"{path}:{line_no}: Invalid list indentation {ind} (expected {expected_indent})"
                    )
                if not (content.startswith("- ") or content == "-"):
                    break
                after_dash = content[2:].strip() if content.startswith("- ") else ""
                idx += 1
                if not after_dash:
                    if idx < len(tokens) and tokens[idx][0] > expected_indent:
                        sub, idx = parse_node(idx, tokens[idx][0])
                        result_list.append(sub)
                    else:
                        result_list.append(None)
                elif ":" in after_dash and not (
                    after_dash.startswith('"') or after_dash.startswith("'") or after_dash.startswith("http://") or after_dash.startswith("https://")
                ):
                    k, v = after_dash.split(":", 1)
                    k = k.strip()
                    v = v.strip()
                    item_dict = {}
                    if block_val is not None:
                        item_dict[k] = block_val
                    elif v == "":
                        if idx < len(tokens) and tokens[idx][0] > expected_indent:
                            sub, idx = parse_node(idx, tokens[idx][0])
                            item_dict[k] = sub
                        else:
                            item_dict[k] = None
                    else:
                        item_dict[k] = _parse_scalar(v)

                    if idx < len(tokens) and tokens[idx][0] > expected_indent:
                        extra_ind = tokens[idx][0]
                        extra_dict, idx = parse_node(idx, extra_ind)
                        if isinstance(extra_dict, dict):
                            item_dict.update(extra_dict)
                        else:
                            raise SimpleYAMLParserError(
                                f"{path}:{tokens[idx - 1][3]}: Expected mapping keys inside list item"
                            )
                    result_list.append(item_dict)
                else:
                    result_list.append(_parse_scalar(after_dash))
            return result_list, idx

        result_dict = {}
        while idx < len(tokens):
            ind, content, block_val, line_no = tokens[idx]
            if ind < expected_indent:
                break
            if ind != expected_indent:
                raise SimpleYAMLParserError(
                    f"{path}:{line_no}: Invalid mapping indentation {ind} (expected {expected_indent}) at '{content}'"
                )
            if content.startswith("- ") or content == "-":
                break
            if ":" not in content:
                raise SimpleYAMLParserError(f"{path}:{line_no}: Expected key: value in '{content}'")
            k, v = content.split(":", 1)
            k = k.strip()
            v = v.strip()
            idx += 1
            if block_val is not None:
                result_dict[k] = block_val
            elif v == "":
                if idx < len(tokens) and tokens[idx][0] > expected_indent:
                    sub, idx = parse_node(idx, tokens[idx][0])
                    result_dict[k] = sub
                else:
                    result_dict[k] = None
            else:
                result_dict[k] = _parse_scalar(v)
        return result_dict, idx

    if not tokens:
        return {}
    parsed, next_idx = parse_node(0, tokens[0][0])
    if next_idx < len(tokens):
        raise SimpleYAMLParserError(
            f"{path}:{tokens[next_idx][3]}: Trailing unparsed content at indentation {tokens[next_idx][0]}"
        )
    return parsed


def substitute_params(val, params):
    if isinstance(val, str):
        out = val
        # A parameter value may itself reference another parameter (for example a URL
        # parameter that contains {GCPProjectId}), so repeat until nothing changes. The
        # pass limit only guards against a parameter that refers to itself.
        for _ in range(8):
            before = out
            for k, v in params.items():
                out = out.replace("{" + k + "}", str(v))
            if out == before:
                break
        return out
    if isinstance(val, list):
        return [substitute_params(x, params) for x in val]
    if isinstance(val, dict):
        return {k: substitute_params(v, params) for k, v in val.items()}
    return val


def render_policy_xml(step, params):
    name = step["name"]
    ptype = step["type"]
    props = substitute_params(step.get("properties") or {}, params)

    if ptype == "JavaScript":
        res_url = props.get("resourceURL", "")
        time_limit = props.get("timeLimit", 200)
        # Optional static <Properties>, readable in the callout as `properties.<name>`.
        js_props = props.get("properties") or {}
        js_props_xml = ""
        if js_props:
            js_prop_lines = "\n".join(
                f'        <Property name="{xml_escape(str(pk))}">{xml_escape(str(pv))}</Property>'
                for pk, pv in js_props.items()
            )
            js_props_xml = f"\n    <Properties>\n{js_prop_lines}\n    </Properties>"
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Javascript async="false" continueOnError="false" enabled="true" timeLimit="{time_limit}" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>{js_props_xml}
    <ResourceURL>{xml_escape(str(res_url))}</ResourceURL>
</Javascript>
"""

    if ptype == "VerifyAPIKey":
        key_ref = props.get("apiKey", "request.header.x-api-key")
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VerifyAPIKey async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <APIKey ref="{xml_escape(str(key_ref))}"/>
</VerifyAPIKey>
"""

    if ptype == "VerifyJWT":
        alg = props.get("algorithm", "RS256")
        src = props.get("source", "auth.extracted_jwt")
        jwks = (props.get("publicKey") or {}).get("jwksUri", "https://www.googleapis.com/oauth2/v3/certs")
        issuer = props.get("issuer", "https://accounts.google.com")
        audience = props.get("audience", "")
        aud_xml = f"\n    <Audience>{xml_escape(str(audience))}</Audience>" if audience else ""
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VerifyJWT async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <Algorithm>{xml_escape(str(alg))}</Algorithm>
    <Source>{xml_escape(str(src))}</Source>
    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    <PublicKey>
        <JWKS uri="{xml_escape(str(jwks))}"/>
    </PublicKey>
    <Issuer>{xml_escape(str(issuer))}</Issuer>{aud_xml}
</VerifyJWT>
"""

    if ptype == "AccessEntity":
        etype = props.get("entityType", "developer")
        ident = props.get("entityIdentifier", "jwt.VJ-VerifyGoogleOIDC.decoded.claim.email")
        sec_type = props.get("secondaryIdentifierType", "developeremail")
        if sec_type == "email":
            sec_type = "developeremail"
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<AccessEntity async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <EntityType value="{xml_escape(str(etype))}"/>
    <EntityIdentifier ref="{xml_escape(str(ident))}" type="{xml_escape(str(sec_type))}"/>
</AccessEntity>
"""

    if ptype == "CORS":
        origins = props.get("allowOrigins", "*")
        methods = props.get("allowMethods", "POST, OPTIONS")
        headers = props.get("allowHeaders", "Content-Type, Authorization, x-api-key")
        max_age = props.get("maxAge", 3600)
        preflight = str(props.get("generatePreflightResponse", True)).lower()
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CORS async="false" continueOnError="false" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <AllowOrigins>{xml_escape(str(origins))}</AllowOrigins>
    <AllowMethods>{xml_escape(str(methods))}</AllowMethods>
    <AllowHeaders>{xml_escape(str(headers))}</AllowHeaders>
    <MaxAge>{max_age}</MaxAge>
    <GeneratePreflightResponse>{preflight}</GeneratePreflightResponse>
</CORS>
"""

    if ptype == "RaiseFault":
        status = props.get("statusCode", 400)
        reason = props.get("reasonPhrase", "Bad Request")
        hdrs = props.get("headers") or {}
        payload = props.get("payload") or {}
        hdr_lines = [
            f'                <Header name="{xml_escape(str(hk))}">{xml_escape(str(hv))}</Header>'
            for hk, hv in hdrs.items()
        ]
        hdr_block = "\n".join(hdr_lines)
        headers_xml = f"\n            <Headers>\n{hdr_block}\n            </Headers>" if hdr_lines else ""
        payload_xml = ""
        if payload:
            ctype = payload.get("contentType", "application/json")
            content = (payload.get("content") or "").strip()
            payload_xml = f'\n            <Payload contentType="{xml_escape(str(ctype))}">{xml_escape(content)}</Payload>'
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<RaiseFault async="false" continueOnError="false" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <FaultResponse>
        <Set>{headers_xml}{payload_xml}
            <StatusCode>{status}</StatusCode>
            <ReasonPhrase>{xml_escape(str(reason))}</ReasonPhrase>
        </Set>
    </FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>
"""

    if ptype == "AssignMessage":
        set_cfg = props.get("set") or {}
        rem_cfg = props.get("remove") or {}
        assign_vars = props.get("assignVariable") or []
        parts = []

        if rem_cfg.get("headers"):
            h_items = "\n".join(
                f'            <Header name="{xml_escape(str(h))}"/>' for h in rem_cfg["headers"]
            )
            parts.append(f"    <Remove>\n        <Headers>\n{h_items}\n        </Headers>\n    </Remove>")

        if set_cfg:
            set_children = []
            if set_cfg.get("headers"):
                sh_items = "\n".join(
                    f'            <Header name="{xml_escape(str(k))}">{xml_escape(str(v))}</Header>'
                    for k, v in set_cfg["headers"].items()
                )
                set_children.append(f"        <Headers>\n{sh_items}\n        </Headers>")
            if set_cfg.get("statusCode"):
                set_children.append(f"        <StatusCode>{set_cfg['statusCode']}</StatusCode>")
            if set_cfg.get("reasonPhrase"):
                set_children.append(f"        <ReasonPhrase>{xml_escape(str(set_cfg['reasonPhrase']))}</ReasonPhrase>")
            if set_cfg.get("payload"):
                pl = set_cfg["payload"]
                if isinstance(pl, dict):
                    ctype = pl.get("contentType", "application/json")
                    pcontent = (pl.get("content") or "").strip()
                    set_children.append(
                        f'        <Payload contentType="{xml_escape(str(ctype))}">{xml_escape(pcontent)}</Payload>'
                    )
                else:
                    set_children.append(f'        <Payload contentType="application/json">{xml_escape(str(pl))}</Payload>')
            parts.append("    <Set>\n" + "\n".join(set_children) + "\n    </Set>")

        if props.get("payload") and not set_cfg.get("payload"):
            pl = props["payload"]
            ctype = pl.get("contentType", "application/json")
            pcontent = (pl.get("content") or "").strip()
            parts.append(
                f'    <Set>\n        <Payload contentType="{xml_escape(str(ctype))}">{xml_escape(pcontent)}</Payload>\n    </Set>'
            )

        for av in assign_vars:
            vname = av.get("name", "")
            vref = av.get("ref")
            vval = av.get("value")
            av_lines = [f"        <Name>{xml_escape(str(vname))}</Name>"]
            if vref is not None:
                av_lines.append(f"        <Ref>{xml_escape(str(vref))}</Ref>")
            if vval is not None:
                av_lines.append(f"        <Value>{xml_escape(str(vval))}</Value>")
            parts.append("    <AssignVariable>\n" + "\n".join(av_lines) + "\n    </AssignVariable>")

        body_xml = "\n".join(parts)
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<AssignMessage async="false" continueOnError="false" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
{body_xml}
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>
"""

    if ptype == "KeyValueMapOperations":
        map_id = props.get("mapIdentifier", "switchyard-secrets")
        scope = props.get("scope", "environment")
        exclusive_cache = str(props.get("exclusiveCache", False)).lower()
        expiry = props.get("expiryTimeInSecs", 300)
        continue_on_err = str(props.get("continueOnError", True)).lower()
        gets = props.get("get") or []
        get_blocks = []
        for g in gets:
            assign_to = g.get("assignTo", "")
            key_params = g.get("key") or []
            if isinstance(key_params, str):
                key_params = [key_params]
            param_lines = "\n".join(
                f"            <Parameter>{xml_escape(str(kp))}</Parameter>"
                for kp in key_params
            )
            get_blocks.append(
                f"""    <Get assignTo="{xml_escape(str(assign_to))}">
        <Key>
{param_lines}
        </Key>
    </Get>"""
            )
        gets_xml = "\n".join(get_blocks)
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<KeyValueMapOperations async="false" continueOnError="{continue_on_err}" enabled="true" name="{xml_escape(name)}" mapIdentifier="{xml_escape(str(map_id))}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <ExclusiveCache>{exclusive_cache}</ExclusiveCache>
    <ExpiryTimeInSecs>{expiry}</ExpiryTimeInSecs>
{gets_xml}
    <Scope>{xml_escape(str(scope))}</Scope>
</KeyValueMapOperations>
"""

    if ptype == "ServiceCallout":
        timeout = props.get("timeout", 30000)
        req_cfg = props.get("request") or {}
        req_var = req_cfg.get("variable", "calloutRequest")
        resp_var = props.get("response", "calloutResponse")
        http_target = props.get("httpTargetConnection") or {}
        url = http_target.get("url", "")
        set_cfg = req_cfg.get("set") or {}
        auth_cfg = http_target.get("authentication") or {}
        auth_mode = str(auth_cfg.get("mode", "")).strip().lower()
        id_token_cfg = auth_cfg.get("googleIdToken") or {}

        hdrs = dict(set_cfg.get("headers") or {})
        if auth_mode in ("api_key", "apikey"):
            ak_header = str(auth_cfg.get("apiKeyHeader", "x-goog-api-key")).strip()
            ak_value = str(auth_cfg.get("apiKeyValue", "")).strip()
            if ak_header and ak_value:
                hdrs[ak_header] = ak_value
        elif auth_mode in ("oauth", "google_access_token", "googleaccesstoken"):
            up_val = str(auth_cfg.get("userProjectHeader", "")).strip()
            if up_val:
                hdrs["x-goog-user-project"] = up_val

        set_xml = ""
        if set_cfg:
            verb = set_cfg.get("verb", "POST")
            pl = set_cfg.get("payload") or {}
            ctype = pl.get("contentType", "application/json")
            pcontent = (pl.get("content") or "").strip()
            hdr_xml = ""
            if hdrs:
                sh_items = "\n".join(
                    f'                <Header name="{xml_escape(str(hk))}">{xml_escape(str(hv))}</Header>'
                    for hk, hv in hdrs.items()
                )
                hdr_xml = f"\n            <Headers>\n{sh_items}\n            </Headers>"
            set_xml = f"""
        <Set>{hdr_xml}
            <Verb>{xml_escape(str(verb))}</Verb>
            <Payload contentType="{xml_escape(str(ctype))}">{xml_escape(pcontent)}</Payload>
        </Set>"""
        # Google APIs take an OAuth access token (the default). IAM-protected services such
        # as Cloud Run take an ID token minted for a specific audience instead. Gemini Developer
        # API endpoints (such as the Decisions API) also support API-key auth via encrypted KVM
        # (mode: api_key, which omits <Authentication> and sends x-goog-api-key).
        if id_token_cfg:
            audience = str(id_token_cfg.get("audience", "")).strip()
            if not audience:
                raise ValueError(f"ServiceCallout '{name}': googleIdToken needs an audience")
            auth_xml = f"""        <Authentication>
            <GoogleIDToken>
                <Audience>{xml_escape(audience)}</Audience>
            </GoogleIDToken>
        </Authentication>\n"""
        elif auth_mode in ("none", "api_key", "apikey"):
            auth_xml = ""
        else:
            raw_scopes = auth_cfg.get("scopes") or (auth_cfg.get("googleAccessToken") or {}).get("scopes") or []
            if isinstance(raw_scopes, dict):
                raw_scopes = [raw_scopes.get("scope")] if raw_scopes.get("scope") else []
            elif isinstance(raw_scopes, str):
                raw_scopes = [raw_scopes]
            if not raw_scopes:
                raw_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
            scope_lines = "\n".join(
                f"                    <Scope>{xml_escape(str(sc))}</Scope>" for sc in raw_scopes if sc
            )
            auth_xml = f"""        <Authentication>
            <GoogleAccessToken>
                <Scopes>
{scope_lines}
                </Scopes>
            </GoogleAccessToken>
        </Authentication>\n"""
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ServiceCallout async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <Timeout>{timeout}</Timeout>
    <Request clearPayload="true" variable="{xml_escape(str(req_var))}">{set_xml}
    </Request>
    <Response>{xml_escape(str(resp_var))}</Response>
    <HTTPTargetConnection>
{auth_xml}        <URL>{xml_escape(str(url))}</URL>
    </HTTPTargetConnection>
</ServiceCallout>
"""

    if ptype == "LLMTokenQuota":
        dist = str(props.get("distributed", True)).lower()
        sync = str(props.get("synchronous", True)).lower()
        enforce_only = str(props.get("enforceOnly", False)).lower()
        count_only = str(props.get("countOnly", False)).lower()
        shared_name = props.get("sharedName", "CodingAgentDeveloperTokenQuota")
        ident = props.get("identifier", "auth.developer_email")
        usage_src = props.get("llmTokenUsageSource")
        allow_cfg = props.get("allow") or {}
        int_cfg = props.get("interval") or {}
        tu_cfg = props.get("timeUnit") or {}
        usage_xml = ""
        if usage_src:
            usage_str = str(usage_src).strip()
            if not (usage_str.startswith("{") and usage_str.endswith("}")):
                usage_str = "{" + usage_str + "}"
            usage_xml = f"\n    <LLMTokenUsageSource>{xml_escape(usage_str)}</LLMTokenUsageSource>"
        int_ref = str(int_cfg.get("ref", "")).strip()
        int_def = str(int_cfg.get("default", "1")).strip()
        int_attr = f' ref="{xml_escape(int_ref)}"' if int_ref else ""
        tu_ref = str(tu_cfg.get("ref", "")).strip()
        tu_def = str(tu_cfg.get("default", "day")).strip()
        tu_attr = f' ref="{xml_escape(tu_ref)}"' if tu_ref else ""
        continue_on_err = str(props.get("continueOnError", "false" if enforce_only == "true" else "true")).lower()
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<LLMTokenQuota async="false" continueOnError="{continue_on_err}" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <SharedName>{xml_escape(str(shared_name))}</SharedName>
    <Distributed>{dist}</Distributed>
    <Synchronous>{sync}</Synchronous>
    <EnforceOnly>{enforce_only}</EnforceOnly>
    <CountOnly>{count_only}</CountOnly>
    <Identifier ref="{xml_escape(str(ident))}"/>{usage_xml}
    <Allow count="{xml_escape(str(allow_cfg.get('defaultCount', '5000000')))}" countRef="{xml_escape(str(allow_cfg.get('countRef', 'auth.llm_quota')))}"/>
    <Interval{int_attr}>{xml_escape(int_def)}</Interval>
    <TimeUnit{tu_attr}>{xml_escape(tu_def)}</TimeUnit>
</LLMTokenQuota>
"""

    if ptype == "SanitizeUserPrompt":
        tmpl = props.get("modelArmorTemplateName", "")
        src = props.get("userPromptSource", "{ai.extractedPrompt}")
        continue_on_err = str(props.get("continueOnError", "true")).lower()
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SanitizeUserPrompt async="false" continueOnError="{continue_on_err}" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <ModelArmor>
        <TemplateName>{xml_escape(str(tmpl))}</TemplateName>
    </ModelArmor>
    <UserPromptSource>{xml_escape(str(src))}</UserPromptSource>
</SanitizeUserPrompt>
"""

    if ptype == "SanitizeModelResponse":
        tmpl = props.get("modelArmorTemplateName", "")
        msrc = props.get("modelResponseSource", "{ai.extractedResponseText}")
        usrc = props.get("userPromptSource", "{ai.extractedPrompt}")
        continue_on_err = str(props.get("continueOnError", "true")).lower()
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SanitizeModelResponse async="false" continueOnError="{continue_on_err}" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <ModelArmor>
        <TemplateName>{xml_escape(str(tmpl))}</TemplateName>
    </ModelArmor>
    <LLMResponseSource>{xml_escape(str(msrc))}</LLMResponseSource>
    <UserPromptSource>{xml_escape(str(usrc))}</UserPromptSource>
</SanitizeModelResponse>
"""

    if ptype == "SemanticCacheLookup":
        src = props.get("userPromptSource", "{ai.extractedPrompt}")
        emb = props.get("embeddingsCreationEndpoint", "")
        sim = props.get("similaritySearchEndpoint", "")
        idx_id = props.get("deployedIndexId", "")
        thresh = props.get("similarityThreshold", "0.92")
        # Must name the measure the Vector Search index was built with; the policy compares
        # the threshold as a similarity for dot product and as a distance for the others.
        measure = str(props.get("distanceMeasureType", "") or "").strip()
        measure_xml = (
            f"\n            <DistanceMeasureType>{xml_escape(measure)}</DistanceMeasureType>" if measure else ""
        )
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SemanticCacheLookup async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <UserPromptSource>{xml_escape(str(src))}</UserPromptSource>
    <Embeddings>
        <VertexAI>
            <URL>{xml_escape(str(emb))}</URL>
        </VertexAI>
    </Embeddings>
    <SimilaritySearch>
        <VertexAI>
            <URL>{xml_escape(str(sim))}</URL>
            <DeployedIndexID>{xml_escape(str(idx_id))}</DeployedIndexID>
            <Threshold>{xml_escape(str(thresh))}</Threshold>{measure_xml}
        </VertexAI>
    </SimilaritySearch>
</SemanticCacheLookup>
"""

    if ptype == "SemanticCachePopulate":
        ttl = props.get("ttlInSeconds", "3600")
        upsert = props.get("upsertEndpoint", "")
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SemanticCachePopulate async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <SimilaritySearch>
        <VertexAI>
            <URL>{xml_escape(str(upsert))}</URL>
        </VertexAI>
    </SimilaritySearch>
    <TTLInSeconds>{xml_escape(str(ttl))}</TTLInSeconds>
</SemanticCachePopulate>
"""

    if ptype == "DataCapture":
        caps = props.get("captures") or []
        cap_xml = [
            f"""    <Capture>
        <DataCollector>{xml_escape(str(c.get("dataCollector", "")))}</DataCollector>
        <Collect ref="{xml_escape(str(c.get("ref", "")))}"/>
    </Capture>"""
            for c in caps
        ]
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<DataCapture async="false" continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
{chr(10).join(cap_xml)}
</DataCapture>
"""

    if ptype == "MessageLogging":
        log_name = substitute_params(props.get("logName", "projects/{GCPProjectId}/logs/apigee-ai-finops"), params)
        msg_ctype = props.get("messageContentType", "application/json")
        msg_tpl = substitute_params(props.get("message", "{ai.finopsLogPayload}"), params)
        res_type = props.get("resourceType", "global")
        log_level = props.get("logLevel", "INFO")
        return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<MessageLogging continueOnError="true" enabled="true" name="{xml_escape(name)}">
    <DisplayName>{xml_escape(name)}</DisplayName>
    <CloudLogging>
        <LogName>{xml_escape(str(log_name))}</LogName>
        <Message contentType="{xml_escape(str(msg_ctype))}">{xml_escape(str(msg_tpl))}</Message>
        <ResourceType>{xml_escape(str(res_type))}</ResourceType>
    </CloudLogging>
    <logLevel>{xml_escape(str(log_level))}</logLevel>
</MessageLogging>
"""

    raise ValueError(f"Unsupported policy type: {ptype}")


def render_step_list(steps, indent="            "):
    lines = []
    for st in steps:
        sname = st["name"] if isinstance(st, dict) else str(st)
        cond = st.get("condition") if isinstance(st, dict) else None
        lines.append(f"{indent}<Step>")
        lines.append(f"{indent}    <Name>{xml_escape(sname)}</Name>")
        if cond:
            lines.append(f"{indent}    <Condition>{xml_escape(str(cond))}</Condition>")
        lines.append(f"{indent}</Step>")
    return "\n".join(lines)


def validate_xml_file(path):
    try:
        ET.parse(path)
    except Exception as exc:
        raise RuntimeError(f"Invalid XML generated in {path}: {exc}") from exc


# Names the compiler provides itself; stage parameters and STAGE_PARAMS may replace them.
SEEDED_PARAMS = (
    "gcp_project_id",
    "GCPProjectId",
    "model_armor_region",
    "model_armor_template_id",
    "ModelArmorTemplatePath",
)


def resolve_configured_params(stage_file, stage_cfg, proxies):
    """Stage `parameters:` overlaid with the STAGE_PARAMS JSON object, after checking names.

    A name that no feature declares would be accepted and then change nothing (a misspelt
    JudgeBackend silently builds the default backend), so it fails the build. Names that
    belong to a feature this particular stage does not include are left alone, so the same
    STAGE_PARAMS value can be reused across stages.
    """
    configured = {}
    for sp in stage_cfg.get("parameters") or []:
        configured[str(sp["name"])] = sp["value"]
    raw_overrides = os.environ.get("STAGE_PARAMS", "").strip()
    if raw_overrides:
        if os.path.isfile(raw_overrides):
            with open(raw_overrides, "r", encoding="utf-8") as fh:
                raw_overrides = fh.read().strip()
        try:
            overrides = json.loads(raw_overrides)
        except ValueError as exc:
            raise RuntimeError(f"STAGE_PARAMS must be a JSON object: {exc}") from exc
        if not isinstance(overrides, dict):
            raise RuntimeError("STAGE_PARAMS must be a JSON object of name -> value")
        for ok, ov in overrides.items():
            configured[str(ok)] = ov

    feature_files = {fpath for p_entry in proxies for fpath in (p_entry.get("features") or [])}
    if os.path.isdir("features"):
        feature_files.update(
            os.path.join("features", fname)
            for fname in os.listdir("features")
            if not fname.startswith(".") and fname.endswith((".yaml", ".yml"))
        )
    declared = set(SEEDED_PARAMS)
    for fpath in sorted(feature_files):
        for dp in parse_yaml_file(fpath).get("defaultParameters") or []:
            declared.add(str(dp["name"]))
    unknown = sorted(name for name in configured if name not in declared)
    if unknown:
        raise RuntimeError(
            f"Unknown parameter(s) for {stage_file}: {', '.join(unknown)}. "
            "Stage parameters and STAGE_PARAMS entries must match a defaultParameters name of a feature."
        )
    return configured


def compile_stage(stage_file, build_dir, gcp_project_id, model_armor_region, model_armor_template_id):
    stage_cfg = parse_yaml_file(stage_file)
    proxies = stage_cfg.get("proxies") or []
    if not proxies:
        raise RuntimeError(f"No proxies defined in {stage_file}")
    configured_params = resolve_configured_params(stage_file, stage_cfg, proxies)

    for p_entry in proxies:
        proxy_name = p_entry["name"]
        template_path = p_entry["template"]
        feature_paths = p_entry.get("features") or []

        template_cfg = parse_yaml_file(template_path)
        proxy_out = os.path.join(build_dir, proxy_name, "apiproxy")
        policies_dir = os.path.join(proxy_out, "policies")
        proxies_dir = os.path.join(proxy_out, "proxies")
        targets_dir = os.path.join(proxy_out, "targets")
        jsc_dir = os.path.join(proxy_out, "resources", "jsc")

        os.makedirs(policies_dir, exist_ok=True)
        os.makedirs(proxies_dir, exist_ok=True)
        os.makedirs(targets_dir, exist_ok=True)
        os.makedirs(jsc_dir, exist_ok=True)

        js_resources = []
        for fname in sorted(os.listdir("src/ai-functions")):
            if not fname.startswith(".") and fname.endswith(".js"):
                shutil.copy2(os.path.join("src/ai-functions", fname), os.path.join(jsc_dir, fname))
                js_resources.append(f"jsc://{fname}")

        params = {
            "gcp_project_id": gcp_project_id,
            "GCPProjectId": gcp_project_id,
            "model_armor_region": model_armor_region,
            "model_armor_template_id": model_armor_template_id,
            "ModelArmorTemplatePath": f"projects/{gcp_project_id}/locations/{model_armor_region}/templates/{model_armor_template_id}",
        }
        # Feature defaults only fill names that are not set yet, so anything seeded here wins.
        # Precedence: STAGE_PARAMS (deploy-time JSON object) > stage `parameters:` > feature defaults.
        params.update(configured_params)

        pre_req_steps, pre_resp_steps, post_req_steps, post_resp_steps, event_resp_steps = [], [], [], [], []
        post_client_resp_steps = []
        proxy_flows, proxy_fault_rules, target_post_resp_steps, target_fault_rules = [], [], [], []
        policy_defs = {}

        for fpath in feature_paths:
            fcfg = parse_yaml_file(fpath)
            for dp in fcfg.get("defaultParameters") or []:
                dp_name = dp["name"]
                if dp_name not in params:
                    params[dp_name] = dp["value"]

            for ep in fcfg.get("endpoints") or []:
                pre = ep.get("preFlow") or {}
                pre_req_steps.extend(pre.get("request") or [])
                pre_resp_steps.extend(pre.get("response") or [])
                post = ep.get("postFlow") or {}
                post_req_steps.extend(post.get("request") or [])
                post_resp_steps.extend(post.get("response") or [])
                ev = ep.get("eventFlow") or {}
                event_resp_steps.extend(ev.get("response") or [])
                pcf = ep.get("postClientFlow") or {}
                post_client_resp_steps.extend(pcf.get("response") or [])
                proxy_flows.extend(ep.get("flows") or [])
                proxy_fault_rules.extend(ep.get("faultRules") or [])

            for tgt in fcfg.get("targets") or []:
                tpost = tgt.get("postFlow") or {}
                target_post_resp_steps.extend(tpost.get("response") or [])
                target_fault_rules.extend(tgt.get("faultRules") or [])

            for st_def in fcfg.get("steps") or []:
                policy_defs[st_def["name"]] = st_def

        # A PreFlow request step may name the step it must directly follow (`after: <step>`),
        # which lets one feature insert into a sequence another feature owns.
        anchored = [s for s in pre_req_steps if isinstance(s, dict) and s.get("after")]
        if anchored:
            pre_req_steps = [s for s in pre_req_steps if not (isinstance(s, dict) and s.get("after"))]
            for st in anchored:
                anchor = str(st["after"])
                names = [s["name"] if isinstance(s, dict) else str(s) for s in pre_req_steps]
                if anchor not in names:
                    raise RuntimeError(
                        f"Step '{st['name']}' asks to run after '{anchor}', which proxy '{proxy_name}' does not have"
                    )
                # Insert after the anchor and after any steps already anchored to it, so
                # several add-ons keep the order their features were listed in.
                pos = names.index(anchor) + 1
                while pos < len(pre_req_steps) and isinstance(pre_req_steps[pos], dict) and pre_req_steps[pos].get("_anchor") == anchor:
                    pos += 1
                placed = {k: v for k, v in st.items() if k != "after"}
                placed["_anchor"] = anchor
                pre_req_steps.insert(pos, placed)

        post_resp_priority = {
            "JS-TransformResponseAndCost": 0,
            "JS-TransformResponseAndCalculateCost": 0,
            "SMR-ValidateResponse": 1,
            "LTQ-EnforceDeveloperTokenQuota": 2,
            "LTQ-CountTokensUnary": 2,
            "SCP-PopulateResponse": 3,
            "DC-CaptureFinOpsTelemetry": 4,
            "DC-CaptureFinOpsMetrics": 4,
            "SC-EmitCloudFinOpsLog": 5,
            "AM-InjectGatewayHeaders": 6,
        }
        post_resp_steps.sort(key=lambda s: post_resp_priority.get(s.get("name", ""), 50))

        event_resp_priority = {
            "JS-TransformStreamEvent": 0,
            "LTQ-CountTokensStream": 1,
            "DC-CaptureFinOpsMetrics": 2,
        }
        event_resp_steps.sort(key=lambda s: event_resp_priority.get(s.get("name", ""), 50))

        policy_defs["AM-DisableTargetPathSuffix"] = {
            "name": "AM-DisableTargetPathSuffix",
            "type": "AssignMessage",
            "properties": {
                "assignVariable": [
                    {"name": "target.copy.pathsuffix", "value": "false"},
                    {"name": "target.copy.queryparams", "value": "false"},
                    {"name": "target.url", "ref": "ai.targetUrl"},
                ]
            },
        }

        spec = template_cfg.get("spec") or {}
        proxy_ep = (spec.get("proxyEndpoints") or [{}])[0]
        base_path = proxy_ep.get("basePath", "/")
        route_rules = proxy_ep.get("routeRules") or []

        # Pre-scan target endpoints for custom auth modes (e.g. Gemini Decisions API target)
        # so any auto-synthesized policies are written to apiproxy/policies/ and listed in the manifest.
        target_extra_preflow = {}
        for tep in spec.get("targetEndpoints") or []:
            tname = tep["name"]
            t_auth = substitute_params((tep.get("httpTargetConnection") or {}).get("authentication") or {}, params)
            t_mode = str(t_auth.get("mode", "")).strip().lower()
            extra_steps = []
            if t_mode in ("api_key", "apikey"):
                if "KVM-GetDecisionsApiKey" not in policy_defs:
                    policy_defs["KVM-GetDecisionsApiKey"] = {
                        "name": "KVM-GetDecisionsApiKey",
                        "type": "KeyValueMapOperations",
                        "properties": {
                            "mapIdentifier": params.get("DecisionsApiKeyKvmMap", "switchyard-secrets"),
                            "scope": "environment",
                            "exclusiveCache": False,
                            "expiryTimeInSecs": 300,
                            "continueOnError": True,
                            "get": [
                                {
                                    "assignTo": "private.decisions.apiKey",
                                    "key": [params.get("DecisionsApiKeyKvmEntry", "gemini_decisions_api_key")],
                                }
                            ],
                        },
                    }
                ak_hdr = str(t_auth.get("apiKeyHeader", "x-goog-api-key")).strip()
                ak_val = str(t_auth.get("apiKeyValue", "{private.decisions.apiKey}")).strip()
                policy_defs["AM-InjectDecisionsTargetAuth"] = {
                    "name": "AM-InjectDecisionsTargetAuth",
                    "type": "AssignMessage",
                    "properties": {
                        "set": {
                            "headers": {
                                ak_hdr: ak_val,
                            }
                        }
                    },
                }
                extra_steps.append({"name": "KVM-GetDecisionsApiKey"})
                extra_steps.append({"name": "AM-InjectDecisionsTargetAuth"})
            elif t_mode in ("oauth", "google_access_token", "googleaccesstoken"):
                up_hdr = str(t_auth.get("userProjectHeader", "{GCPProjectId}")).strip()
                if up_hdr:
                    policy_defs["AM-InjectDecisionsTargetAuth"] = {
                        "name": "AM-InjectDecisionsTargetAuth",
                        "type": "AssignMessage",
                        "properties": {
                            "set": {
                                "headers": {
                                    "x-goog-user-project": up_hdr,
                                }
                            }
                        },
                    }
                    extra_steps.append({"name": "AM-InjectDecisionsTargetAuth"})
            target_extra_preflow[tname] = extra_steps

        all_referenced_steps = (
            pre_req_steps
            + pre_resp_steps
            + post_req_steps
            + post_resp_steps
            + event_resp_steps
            + post_client_resp_steps
            + target_post_resp_steps
        )
        for fl in proxy_flows:
            all_referenced_steps.extend(fl.get("request") or [])
            all_referenced_steps.extend(fl.get("response") or [])
        for fr in proxy_fault_rules + target_fault_rules:
            all_referenced_steps.extend(fr.get("steps") or [])
        for extra_list in target_extra_preflow.values():
            all_referenced_steps.extend(extra_list)
        for st_ref in all_referenced_steps:
            st_name = st_ref["name"] if isinstance(st_ref, dict) else str(st_ref)
            if st_name not in policy_defs:
                raise RuntimeError(f"Flow references undefined policy '{st_name}' in proxy '{proxy_name}'")

        for pname, pdef in sorted(policy_defs.items()):
            pxml = render_policy_xml(pdef, params)
            ppath = os.path.join(policies_dir, f"{pname}.xml")
            with open(ppath, "w", encoding="utf-8") as f:
                f.write(pxml)
            validate_xml_file(ppath)

        flows_xml_parts = []
        for fl in proxy_flows:
            fl_name = fl.get("name", "Flow")
            fl_cond = fl.get("condition", "")
            fl_req = render_step_list(fl.get("request") or [], "                ")
            fl_resp = render_step_list(fl.get("response") or [], "                ")
            cond_line = f"\n            <Condition>{xml_escape(str(fl_cond))}</Condition>" if fl_cond else ""
            flows_xml_parts.append(
                f"""        <Flow name="{xml_escape(fl_name)}">
            <Request>
{fl_req}
            </Request>
            <Response>
{fl_resp}
            </Response>{cond_line}
        </Flow>"""
            )

        fault_xml_parts = []
        for fr in proxy_fault_rules:
            fr_name = fr.get("name", "FaultRule")
            fr_cond = fr.get("condition", "")
            fr_steps = render_step_list(fr.get("steps") or [], "            ")
            cond_line = f"\n        <Condition>{xml_escape(str(fr_cond))}</Condition>" if fr_cond else ""
            fault_xml_parts.append(
                f"""    <FaultRule name="{xml_escape(fr_name)}">
{fr_steps}{cond_line}
    </FaultRule>"""
            )

        route_xml_parts = []
        for rr in route_rules:
            rr_name = rr.get("name", "default")
            rr_cond = rr.get("condition")
            rr_target = rr.get("targetEndpoint")
            rr_lines = [f'    <RouteRule name="{xml_escape(rr_name)}">']
            if rr_cond:
                rr_lines.append(f"        <Condition>{xml_escape(str(rr_cond))}</Condition>")
            if rr_target:
                rr_lines.append(f"        <TargetEndpoint>{xml_escape(str(rr_target))}</TargetEndpoint>")
            rr_lines.append("    </RouteRule>")
            route_xml_parts.append("\n".join(rr_lines))

        event_flow_xml = ""
        if event_resp_steps:
            ev_steps_str = render_step_list(event_resp_steps, "            ")
            event_flow_xml = f"""
    <EventFlow content-type="text/event-stream" name="EventFlow">
        <Request/>
        <Response>
{ev_steps_str}
        </Response>
    </EventFlow>"""

        post_client_flow_xml = ""
        if post_client_resp_steps:
            pcf_steps_no_cond = [
                {"name": (st["name"] if isinstance(st, dict) else str(st))}
                for st in post_client_resp_steps
            ]
            pcf_steps_str = render_step_list(pcf_steps_no_cond, "            ")
            post_client_flow_xml = f"""
    <PostClientFlow>
        <Response>
{pcf_steps_str}
        </Response>
    </PostClientFlow>"""

        proxy_default_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ProxyEndpoint name="default">
    <Description>{xml_escape(str((template_cfg.get("metadata") or {}).get("description", proxy_name)))}</Description>
    <FaultRules>
{chr(10).join(fault_xml_parts)}
    </FaultRules>
    <PreFlow name="PreFlow">
        <Request>
{render_step_list(pre_req_steps, "            ")}
        </Request>
        <Response>
{render_step_list(pre_resp_steps, "            ")}
        </Response>
    </PreFlow>
    <Flows>
{chr(10).join(flows_xml_parts)}
    </Flows>
    <PostFlow name="PostFlow">
        <Request>
{render_step_list(post_req_steps, "            ")}
        </Request>
        <Response>
{render_step_list(post_resp_steps, "            ")}
        </Response>
    </PostFlow>{event_flow_xml}{post_client_flow_xml}
    <HTTPProxyConnection>
        <BasePath>{xml_escape(str(base_path))}</BasePath>
    </HTTPProxyConnection>
{chr(10).join(route_xml_parts)}
</ProxyEndpoint>
"""
        proxy_default_path = os.path.join(proxies_dir, "default.xml")
        with open(proxy_default_path, "w", encoding="utf-8") as f:
            f.write(proxy_default_xml)
        validate_xml_file(proxy_default_path)

        target_names = []
        for tep in spec.get("targetEndpoints") or []:
            tname = tep["name"]
            target_names.append(tname)
            http_conn = tep.get("httpTargetConnection") or {}
            raw_url = substitute_params(http_conn.get("url", ""), params)
            tprops = http_conn.get("properties") or {}
            prop_lines = [
                f'            <Property name="{xml_escape(str(pk))}">{xml_escape(str(pv))}</Property>'
                for pk, pv in tprops.items()
            ]
            t_fault_parts = []
            use_vertex_fallback = not bool(tep.get("disableVertexFallback"))
            if use_vertex_fallback:
                for tfr in target_fault_rules:
                    tfr_name = tfr.get("name", "TargetFaultRule")
                    tfr_cond = tfr.get("condition", "")
                    tfr_steps = render_step_list(tfr.get("steps") or [], "            ")
                    tfr_cond_line = f"\n        <Condition>{xml_escape(str(tfr_cond))}</Condition>" if tfr_cond else ""
                    t_fault_parts.append(
                        f"""    <FaultRule name="{xml_escape(tfr_name)}">
{tfr_steps}{tfr_cond_line}
    </FaultRule>"""
                    )
            eff_target_post_resp = target_post_resp_steps if use_vertex_fallback else []

            t_preflow_steps = [{"name": "AM-DisableTargetPathSuffix"}] + list(
                target_extra_preflow.get(tname) or []
            )
            t_auth = substitute_params(http_conn.get("authentication") or {}, params)
            t_mode = str(t_auth.get("mode", "")).strip().lower()
            if t_mode in ("none", "api_key", "apikey"):
                t_auth_xml = ""
            else:
                t_scopes = t_auth.get("scopes") or (t_auth.get("googleAccessToken") or {}).get("scopes") or []
                if isinstance(t_scopes, str):
                    t_scopes = [t_scopes]
                if not t_scopes:
                    t_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
                t_scope_lines = "\n".join(
                    f"                    <Scope>{xml_escape(str(sc))}</Scope>" for sc in t_scopes if sc
                )
                t_auth_xml = f"""        <Authentication>
            <GoogleAccessToken>
                <Scopes>
{t_scope_lines}
                </Scopes>
            </GoogleAccessToken>
        </Authentication>\n"""

            target_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<TargetEndpoint name="{xml_escape(tname)}">
    <FaultRules>
{chr(10).join(t_fault_parts)}
    </FaultRules>
    <PreFlow name="PreFlow">
        <Request>
{render_step_list(t_preflow_steps, "            ")}
        </Request>
        <Response/>
    </PreFlow>
    <Flows/>
    <PostFlow name="PostFlow">
        <Request/>
        <Response>
{render_step_list(eff_target_post_resp, "            ")}
        </Response>
    </PostFlow>
    <HTTPTargetConnection>
{t_auth_xml}        <Properties>
{chr(10).join(prop_lines)}
        </Properties>
        <URL>{xml_escape(str(raw_url))}</URL>
    </HTTPTargetConnection>
</TargetEndpoint>
"""
            tpath = os.path.join(targets_dir, f"{tname}.xml")
            with open(tpath, "w", encoding="utf-8") as f:
                f.write(target_xml)
            validate_xml_file(tpath)

        pol_items = "\n".join(
            f"        <Policy>{xml_escape(pname)}</Policy>" for pname in sorted(policy_defs.keys())
        )
        res_items = "\n".join(f"        <Resource>{xml_escape(r)}</Resource>" for r in js_resources)
        tgt_items = "\n".join(f"        <TargetEndpoint>{xml_escape(tn)}</TargetEndpoint>" for tn in target_names)
        desc = (template_cfg.get("metadata") or {}).get("description", proxy_name)
        manifest_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<APIProxy revision="1" name="{xml_escape(proxy_name)}">
    <DisplayName>{xml_escape(proxy_name)}</DisplayName>
    <Description>{xml_escape(str(desc))}</Description>
    <Policies>
{pol_items}
    </Policies>
    <ProxyEndpoints>
        <ProxyEndpoint>default</ProxyEndpoint>
    </ProxyEndpoints>
    <Resources>
{res_items}
    </Resources>
    <TargetEndpoints>
{tgt_items}
    </TargetEndpoints>
</APIProxy>
"""
        manifest_path = os.path.join(proxy_out, f"{proxy_name}.xml")
        with open(manifest_path, "w", encoding="utf-8") as f:
            f.write(manifest_xml)
        validate_xml_file(manifest_path)


compile_stage(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
PYEOF

for PROXY_NAME in claude-code-gateway antigravity-gateway codex-gateway; do
  (cd "${BUILD_DIR}/${PROXY_NAME}" && zip -qr "../${PROXY_NAME}.zip" apiproxy)
  rm -rf "${BUILD_DIR}/${PROXY_NAME}"
  echo "  [OK] Compiled & packaged XML bundle: ${BUILD_DIR}/${PROXY_NAME}.zip"
done

echo "Build complete. Bundles available in ${BUILD_DIR}/"
if [[ "${BUILD_ONLY}" != "true" ]]; then
  echo ""
  echo "Note: Imperative script deployment has been retired in favor of declarative Terraform."
  echo "To deploy the gateway and control plane in GCP via Cloud Build:"
  echo "  gcloud builds submit --project="${GCP_PROJECT_ID}" --config=infra/cloudbuild-terraform.yaml ."
fi
