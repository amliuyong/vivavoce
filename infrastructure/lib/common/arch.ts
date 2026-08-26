import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CONTAINER_ARCH } from './constants';

/**
 * 容器 CPU 架构映射(env AIM_CONTAINER_ARCH → CDK 各处枚举)。单一事实源:constants.CONTAINER_ARCH。
 * 构建架构 == 运行架构(DockerImageAsset platform 与 Fargate runtimePlatform / Lambda architecture 一致),
 * x86 builders produce amd64 images and ARM builders produce arm64 images
 * without qemu cross-architecture emulation.
 */
const IS_AMD64 = CONTAINER_ARCH === 'amd64';

/** DockerImageAsset / lambda DockerImageCode 的 build platform。 */
export const IMAGE_PLATFORM: ecrAssets.Platform = IS_AMD64
  ? ecrAssets.Platform.LINUX_AMD64
  : ecrAssets.Platform.LINUX_ARM64;

/** Fargate task runtimePlatform 的 cpuArchitecture。 */
export const ECS_CPU_ARCH: ecs.CpuArchitecture = IS_AMD64
  ? ecs.CpuArchitecture.X86_64
  : ecs.CpuArchitecture.ARM64;

/** Lambda architecture。 */
export const LAMBDA_ARCH: lambda.Architecture = IS_AMD64
  ? lambda.Architecture.X86_64
  : lambda.Architecture.ARM_64;

/**
 * Optional package mirrors are passed as Docker build arguments. Public
 * configuration uses VIVA_NPM_REGISTRY and VIVA_PIP_INDEX_URL; the script
 * compatibility layer exports the runtime names consumed here.
 */
export function imageBuildArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const npm = process.env.AIM_NPM_REGISTRY?.trim();
  const pip = process.env.AIM_PIP_INDEX_URL?.trim();
  if (npm) args.NPM_REGISTRY = npm;
  if (pip) args.PIP_INDEX_URL = pip;
  return args;
}
