@echo off
setlocal enabledelayedexpansion

REM RouteCodex Auto Build and Install Script (Windows)
REM 自动构建并全局安装脚本

REM 检查是否以管理员权限运行
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [WARNING] 没有管理员权限，某些操作可能失败
    echo 建议以管理员身份运行此脚本
    echo.
)

REM 检查前置条件
echo [INFO] 检查前置条件...

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js 未安装，请先安装 Node.js
    pause
    exit /b 1
)

npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm 未安装，请先安装 npm
    pause
    exit /b 1
)

echo [SUCCESS] 前置条件检查通过
echo.

REM 解析参数
set SKIP_TESTS=false
set VERBOSE=false

:parse_args
if "%~1"=="" goto :parse_done
if "%~1"=="--skip-tests" (
    set SKIP_TESTS=true
    shift
    goto :parse_args
)
if "%~1"=="--verbose" (
    set VERBOSE=true
    shift
    goto :parse_args
)
if "%~1"=="--help" goto :show_help
if "%~1"=="-h" goto :show_help
shift
goto :parse_args

:parse_done

echo 开始 RouteCodex 自动构建和安装流程...
echo ========================================

REM 清理旧的构建文件
echo [INFO] 清理旧的构建文件...

if exist "dist" (
    rmdir /s /q dist
    echo [INFO] 已清理 dist 目录
)

if exist "routecodex-*.tgz" (
    del /q routecodex-*.tgz
    echo [INFO] 已清理旧的 tarball 文件
)

REM 运行测试（可选）
if "%SKIP_TESTS%"=="false" (
    echo [INFO] 运行测试...
    call npm test
    if %errorlevel% neq 0 (
        echo [WARNING] 测试失败，但继续构建...
    ) else (
        echo [SUCCESS] 测试通过
    )
) else (
    echo [WARNING] 跳过测试
)

REM 构建项目
echo [INFO] 开始构建项目...

REM 安装依赖
echo [INFO] 安装依赖...
call npm install

REM 构建项目
echo [INFO] 编译 TypeScript...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] 项目构建失败
    pause
    exit /b 1
)
echo [SUCCESS] 项目构建成功

REM 创建包
echo [INFO] 创建 npm 包...
call npm pack
if %errorlevel% neq 0 (
    echo [ERROR] 包创建失败
    pause
    exit /b 1
)

REM 查找创建的包文件
set PACKAGE_FILE=
for /f "delims=" %%f in ('dir /b routecodex-*.tgz 2^>nul') do (
    set PACKAGE_FILE=%%f
)

if defined PACKAGE_FILE (
    echo [SUCCESS] 包创建成功: !PACKAGE_FILE!
) else (
    echo [ERROR] 包创建失败
    pause
    exit /b 1
)

REM 卸载旧版本
echo [INFO] 检查并卸载旧版本...
npm list -g routecodex >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] 发现旧版本，正在卸载...
    call npm uninstall -g routecodex
    if %errorlevel% neq 0 (
        echo [WARNING] 旧版本卸载失败
    ) else (
        echo [SUCCESS] 旧版本卸载成功
    )
) else (
    echo [INFO] 未发现旧版本
)

REM 安装新版本
echo [INFO] 安装新版本...
call npm install -g "!PACKAGE_FILE!"
if %errorlevel% neq 0 (
    echo [ERROR] 新版本安装失败
    pause
    exit /b 1
)
echo [SUCCESS] 新版本安装成功

REM 验证安装
echo [INFO] 验证安装...
timeout /t 2 /nobreak >nul

routecodex --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('routecodex --version') do (
        set VERSION=%%v
    )
    echo [SUCCESS] RouteCodex 安装成功，版本: !VERSION!

    REM 测试基本命令
    echo [INFO] 测试基本命令...
    routecodex --help >nul 2>&1
    if %errorlevel% equ 0 (
        echo [SUCCESS] CLI 命令正常工作
    )

    routecodex examples >nul 2>&1
    if %errorlevel% equ 0 (
        echo [SUCCESS] 示例命令正常工作
    )
) else (
    echo [ERROR] RouteCodex 安装验证失败
    pause
    exit /b 1
)

REM 清理临时文件
echo [INFO] 清理临时文件...
if exist "!PACKAGE_FILE!" (
    del /q "!PACKAGE_FILE!"
    echo [INFO] 已清理 tarball 文件
)

echo ========================================
echo [SUCCESS] RouteCodex 构建和安装完成！

REM 显示使用提示
echo.
echo 快速开始：
echo   查看帮助:    routecodex --help
echo   查看示例:    routecodex examples
echo   初始化配置:  routecodex config init
echo   启动服务器:  routecodex start
echo.

pause
exit /b 0

:show_help
echo RouteCodex 自动构建和安装脚本 (Windows)
echo.
echo 用法: %~nx0 [选项]
echo.
echo 选项:
echo     --skip-tests    跳过测试
echo     --verbose       详细输出
echo     --help, -h      显示帮助信息
echo.
echo 示例:
echo     %~nx0              # 完整构建和安装
echo     %~nx0 --skip-tests # 跳过测试的构建和安装
echo     %~nx0 --help       # 显示帮助
echo.
pause
exit /b 0