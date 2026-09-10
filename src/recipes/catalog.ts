import guardedEditBody from "../../recipes/guarded-edit.md" with {
  type: "text",
}
import guardedEditSource from "../../recipes/guarded-edit.js" with {
  type: "text",
}
import startWorkBody from "../../recipes/start-work.md" with { type: "text" }
import startWorkSource from "../../recipes/start-work.js" with { type: "text" }
import createPrBody from "../../recipes/create-pr.md" with { type: "text" }
import createPrSource from "../../recipes/create-pr.sh" with { type: "text" }
import githubAutolinkBody from "../../recipes/github-autolink.md" with {
  type: "text",
}
import githubAutolinkSource from "../../recipes/github-autolink.sh" with {
  type: "text",
}
import jjCommitsBody from "../../recipes/jj-commits.md" with { type: "text" }
import jjCommitsSource from "../../recipes/jj-commits.js" with { type: "text" }
import migrateTeamBody from "../../recipes/migrate-team.md" with {
  type: "text",
}
import migrateTeamSource from "../../recipes/migrate-team.js" with {
  type: "text",
}
import doctorBody from "../../recipes/doctor.md" with { type: "text" }
import doctorSource from "../../recipes/doctor.js" with { type: "text" }

/** 每项说明和脚本原文都静态嵌入二进制，不依赖源码目录或远端下载。 */
export const recipes = [
  {
    name: "guarded-edit",
    description: "保存初读，讨论或编辑后按原始依据更新 Issue 正文",
    filename: "guarded-edit.js",
    body: guardedEditBody,
    source: guardedEditSource,
  },
  {
    name: "start-work",
    description: "建立 Git/Jujutsu 工作上下文，再更新 Issue 状态",
    filename: "start-work.js",
    body: startWorkBody,
    source: startWorkSource,
  },
  {
    name: "create-pr",
    description: "读取 Issue 标题，用准备好的正文创建 GitHub PR",
    filename: "create-pr.sh",
    body: createPrBody,
    source: createPrSource,
  },
  {
    name: "github-autolink",
    description: "为指定 GitHub 仓库配置 Linear 编号自动链接",
    filename: "github-autolink.sh",
    body: githubAutolinkBody,
    source: githubAutolinkSource,
  },
  {
    name: "jj-commits",
    description: "按完整 Issue 编号查找 Jujutsu 提交",
    filename: "jj-commits.js",
    body: jjCommitsBody,
    source: jjCommitsSource,
  },
  {
    name: "migrate-team",
    description: "迁移未归档 Issue，保存结果和编号映射",
    filename: "migrate-team.js",
    body: migrateTeamBody,
    source: migrateTeamSource,
  },
  {
    name: "doctor",
    description: "按可修改的组织规则检查任务与项目，生成只读候选报告",
    filename: "doctor.js",
    body: doctorBody,
    source: doctorSource,
  },
]

export function findRecipe(name: string) {
  return recipes.find((recipe) => recipe.name === name)
}

export function listRecipes() {
  return recipes.map(({ name, description }) => ({ name, description }))
}
