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
    name: "migrate-team",
    description: "冻结团队 Issue 范围与原始依据，生成迁移交付清单",
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
