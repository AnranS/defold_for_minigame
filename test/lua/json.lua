-- A small JSON module for running minigame.lua outside Defold.
-- It mirrors the two behaviours of Defold's built-in `json` module that the
-- SDK relies on: an empty table encodes as an object, and null decodes to nil.

local json = {}

local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function encode_string(value)
    return '"' .. value:gsub('[%c"\\]', function(character)
        return escapes[character] or string.format("\\u%04x", character:byte())
    end) .. '"'
end

local function is_array(value)
    local count = 0
    for key in pairs(value) do
        if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
            return false
        end
        count = count + 1
    end
    return count > 0 and count == #value
end

local function encode(value)
    local kind = type(value)
    if kind == "nil" then
        return "null"
    elseif kind == "boolean" then
        return value and "true" or "false"
    elseif kind == "number" then
        if value % 1 == 0 and math.abs(value) < 1e15 then
            return string.format("%d", value)
        end
        return string.format("%.14g", value)
    elseif kind == "string" then
        return encode_string(value)
    elseif kind == "table" then
        local parts = {}
        if is_array(value) then
            for index = 1, #value do
                parts[index] = encode(value[index])
            end
            return "[" .. table.concat(parts, ",") .. "]"
        end
        local keys = {}
        for key in pairs(value) do
            keys[#keys + 1] = tostring(key)
        end
        table.sort(keys)
        for index, key in ipairs(keys) do
            local field = value[key]
            if field == nil then field = value[tonumber(key)] end
            parts[index] = encode_string(key) .. ":" .. encode(field)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    error("cannot encode a " .. kind)
end

function json.encode(value)
    return encode(value)
end

local function decode_error(text, position, message)
    error(("json: %s at character %d"):format(message, position), 0)
end

local function skip(text, position)
    local _, finish = text:find("^[ \n\r\t]*", position)
    return finish + 1
end

local decode_value

local function decode_string(text, position)
    local out = {}
    local index = position + 1
    while true do
        local character = text:sub(index, index)
        if character == "" then
            decode_error(text, index, "unterminated string")
        elseif character == '"' then
            return table.concat(out), index + 1
        elseif character == "\\" then
            local escape = text:sub(index + 1, index + 1)
            local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
            if escape == "u" then
                local code = tonumber(text:sub(index + 2, index + 5), 16)
                if not code then decode_error(text, index, "bad unicode escape") end
                if code < 0x80 then
                    out[#out + 1] = string.char(code)
                elseif code < 0x800 then
                    out[#out + 1] = string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
                else
                    out[#out + 1] = string.char(0xE0 + math.floor(code / 0x1000), 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
                end
                index = index + 6
            elseif map[escape] then
                out[#out + 1] = map[escape]
                index = index + 2
            else
                decode_error(text, index, "bad escape")
            end
        else
            out[#out + 1] = character
            index = index + 1
        end
    end
end

decode_value = function(text, position)
    position = skip(text, position)
    local character = text:sub(position, position)
    if character == "{" then
        local object = {}
        position = skip(text, position + 1)
        if text:sub(position, position) == "}" then return object, position + 1 end
        while true do
            position = skip(text, position)
            if text:sub(position, position) ~= '"' then decode_error(text, position, "expected a key") end
            local key
            key, position = decode_string(text, position)
            position = skip(text, position)
            if text:sub(position, position) ~= ":" then decode_error(text, position, "expected ':'") end
            object[key], position = decode_value(text, position + 1)
            position = skip(text, position)
            local separator = text:sub(position, position)
            if separator == "}" then return object, position + 1 end
            if separator ~= "," then decode_error(text, position, "expected ',' or '}'") end
            position = position + 1
        end
    elseif character == "[" then
        local array = {}
        position = skip(text, position + 1)
        if text:sub(position, position) == "]" then return array, position + 1 end
        while true do
            local value
            value, position = decode_value(text, position)
            array[#array + 1] = value
            position = skip(text, position)
            local separator = text:sub(position, position)
            if separator == "]" then return array, position + 1 end
            if separator ~= "," then decode_error(text, position, "expected ',' or ']'") end
            position = position + 1
        end
    elseif character == '"' then
        return decode_string(text, position)
    elseif text:sub(position, position + 3) == "true" then
        return true, position + 4
    elseif text:sub(position, position + 4) == "false" then
        return false, position + 5
    elseif text:sub(position, position + 3) == "null" then
        return nil, position + 4
    end
    local number = text:match("^-?%d+%.?%d*[eE]?[+-]?%d*", position)
    if number and tonumber(number) then
        return tonumber(number), position + #number
    end
    decode_error(text, position, "unexpected character")
end

function json.decode(text)
    local value, position = decode_value(text, 1)
    position = skip(text, position)
    if position <= #text then decode_error(text, position, "trailing characters") end
    return value
end

return json
