/**
 * 프로젝트 템플릿 정의
 *
 * /twindevbot new <directory> --template <key> 에서 사용.
 * 각 프레임워크의 공식 scaffold CLI 커맨드를 정의합니다.
 */
import { execSync } from "child_process";
import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from "fs";
import https from "https";
import { tmpdir } from "os";
import { join } from "path";
import { t } from "./i18n/index.js";

export interface FrameworkTemplate {
  name: string;
  category: "frontend" | "backend";
  /**
   * scaffold 명령어 또는 Node.js 함수를 반환.
   * - string: 셸 명령어 (cwd가 BASE_DIR인 상태에서 실행됨)
   * - (cwd: string) => Promise<void>: Node.js API로 직접 수행 (크로스 플랫폼)
   */
  scaffold: (projectName: string) => string | ((cwd: string) => Promise<void>);
  /** scaffold 실행 타임아웃 (ms). 미지정 시 DEFAULT_SCAFFOLD_TIMEOUT 적용 */
  timeout?: number;
}

/** 기본 scaffold 타임아웃: 5분 */
export const DEFAULT_SCAFFOLD_TIMEOUT = 300_000;

const MAX_REDIRECTS = 10;

/** 다운로드 요청 타임아웃: 30초 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * URL에서 파일을 다운로드 (리다이렉트 지원, 최대 MAX_REDIRECTS 회)
 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (targetUrl: string, redirectCount: number) => {
      if (redirectCount > MAX_REDIRECTS) {
        reject(new Error(`Too many redirects (max ${MAX_REDIRECTS})`));
        return;
      }
      const req = https.get(targetUrl, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error("Redirect without location header"));
            return;
          }
          res.resume();
          const resolved = new URL(location, targetUrl).href;
          request(resolved, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => { file.close(() => resolve()); });
        file.on("error", reject);
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${targetUrl}`));
      });
      req.on("error", reject);
    };
    request(url, 0);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Defence-in-depth: scaffold 함수 내부에서도 프로젝트 이름을 검증
// ─────────────────────────────────────────────────────────────────────────

const SAFE_PROJECT_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function assertSafeProjectName(name: string): void {
  if (name === "." || name === "..") {
    throw new Error(
      `Unsafe project name: "${name}". Directory traversal names are not allowed.`,
    );
  }
  if (name.startsWith("-")) {
    throw new Error(
      `Unsafe project name: "${name}". Names starting with "-" are not allowed.`,
    );
  }
  if (!SAFE_PROJECT_NAME_RE.test(name)) {
    throw new Error(
      `Unsafe project name: "${name}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`,
    );
  }
}

export const TEMPLATES: Record<string, FrameworkTemplate> = {
  // ── Frontend ──────────────────────────────────────────────

  react: {
    name: "React (Vite + TypeScript)",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npm create vite@latest ${name} -- --template react-ts --no-interactive`;
    },
  },

  nextjs: {
    name: "Next.js",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx create-next-app@latest ${name} --yes --ts --eslint --app --src-dir --tailwind --import-alias "@/*" --use-npm`;
    },
    timeout: 600_000,
  },

  vue: {
    name: "Vue (create-vue)",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npm create vue@latest ${name} -- --ts --router --pinia --eslint --prettier`;
    },
  },

  nuxt: {
    name: "Nuxt",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx nuxi@latest init ${name} --template v4-compat --gitInit false --packageManager npm --no-modules`;
    },
  },

  sveltekit: {
    name: "SvelteKit",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx sv create ${name} --template minimal --types ts --no-add-ons --no-install`;
    },
  },

  angular: {
    name: "Angular",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx @angular/cli@latest new ${name} --defaults --skip-install --no-interactive`;
    },
  },

  "react-native-expo": {
    name: "React Native (Expo)",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx create-expo-app@latest ${name} --template blank-typescript --yes`;
    },
    timeout: 600_000,
  },

  "react-native-bare": {
    name: "React Native (Bare CLI)",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      // React Native CLI requires PascalCase project names (no hyphens)
      const pascalName = name
        .split(/[-_]+/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("");
      return `npx @react-native-community/cli@latest init ${pascalName} --directory ${name}`;
    },
    timeout: 600_000,
  },

  flutter: {
    name: "Flutter",
    category: "frontend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `flutter create ${name}`;
    },
  },

  // ── Backend ───────────────────────────────────────────────

  express: {
    name: "Express",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx express-generator ${name} --no-view`;
    },
  },

  nestjs: {
    name: "NestJS",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx @nestjs/cli@latest new ${name} --package-manager npm --skip-install --skip-git`;
    },
  },

  fastify: {
    name: "Fastify (TypeScript)",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `npx fastify-cli generate ${name} --lang=ts`;
    },
  },

  "spring-boot": {
    name: "Spring Boot",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return async (cwd: string) => {
        const zipPath = join(tmpdir(), `spring-${name}.zip`);
        const safePkgName = name.replace(/-/g, "_");
        const enc = encodeURIComponent;
        const url = `https://start.spring.io/starter.zip?type=maven-project&language=java&baseDir=${enc(name)}&groupId=com.example&artifactId=${enc(name)}&name=${enc(name)}&packageName=${enc(`com.example.${safePkgName}`)}&dependencies=web`;

        try {
          await downloadFile(url, zipPath);

          if (process.platform === "win32") {
            execSync(
              `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '.' -Force"`,
              { cwd },
            );
          } else {
            execSync(`unzip -q "${zipPath}" -d .`, { cwd });
          }
        } finally {
          try { unlinkSync(zipPath); } catch { /* 파일이 없을 수 있음 */ }
        }
      };
    },
    timeout: 600_000,
  },

  django: {
    name: "Django",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `django-admin startproject ${name}`;
    },
  },

  fastapi: {
    name: "FastAPI",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return async (cwd: string) => {
        const dir = join(cwd, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "main.py"),
          [
            "from fastapi import FastAPI",
            "",
            "app = FastAPI()",
            "",
            "",
            '@app.get("/")',
            "def read_root():",
            '    return {"Hello": "World"}',
            "",
          ].join("\n"),
        );
      };
    },
  },

  go: {
    name: "Go (module)",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return async (cwd: string) => {
        const dir = join(cwd, name);
        mkdirSync(dir, { recursive: true });
        execSync(`go mod init example.com/${name}`, { cwd: dir });
      };
    },
  },

  rails: {
    name: "Ruby on Rails (API)",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `rails new ${name} --skip-bundle --skip-git --api`;
    },
    timeout: 600_000,
  },

  laravel: {
    name: "Laravel",
    category: "backend",
    scaffold: (name) => {
      assertSafeProjectName(name);
      return `composer create-project laravel/laravel ${name} --no-interaction --prefer-dist`;
    },
    timeout: 600_000,
  },

};

/**
 * 템플릿 조회
 */
export function getTemplate(key: string): FrameworkTemplate | undefined {
  return TEMPLATES[key.toLowerCase()];
}

/**
 * 사용 가능한 템플릿 목록 (카테고리별 그룹)
 */
export function getTemplateListText(): string {
  const grouped: Record<string, string[]> = {
    frontend: [],
    backend: [],
  };

  for (const [key, tmpl] of Object.entries(TEMPLATES)) {
    grouped[tmpl.category].push(`\`${key}\``);
  }

  const lines: string[] = [];
  lines.push("> " + t("template.frontend") + grouped.frontend.join(", "));
  lines.push("> " + t("template.backend") + grouped.backend.join(", "));

  return lines.join("\n");
}
