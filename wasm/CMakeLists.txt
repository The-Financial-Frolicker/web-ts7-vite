cmake_minimum_required(VERSION 4.2)

project(wasm_math LANGUAGES CXX)

# Emscripten 6.0.13's Clang accepts -std=c++26 and reports __cplusplus 202400L.
# The project requires the standard and uses no compiler extensions.
set(CMAKE_CXX_STANDARD 26)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(wasm_math
    src/wasm_math.cpp
)

target_link_options(wasm_math PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    # Browser-only glue: no Node loading path is emitted, and Emscripten's
    # environment detection selects the web branch. Loading it under Node
    # aborts, which is intended: the delivered artefact targets browsers.
    "-sENVIRONMENT=web"
)

set(WASM_WEB_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../public/wasm")

add_custom_command(TARGET wasm_math POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
        "${WASM_WEB_OUTPUT_DIR}"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:wasm_math>"
        "${WASM_WEB_OUTPUT_DIR}/wasm_math.js"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/wasm_math.wasm"
        "${WASM_WEB_OUTPUT_DIR}/wasm_math.wasm"

    COMMENT "Publishing WebAssembly artifacts to Vite public directory"
)