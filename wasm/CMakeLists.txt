cmake_minimum_required(VERSION 4.2)

project(wasm_math LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(wasm_math
    src/wasm_math.cpp
)

target_link_options(wasm_math PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,node"
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